// server config params
const config = require('./config')
// создаем сервер
const WebSocketServer = require('ws').Server
const wss = new WebSocketServer({port: config.ws_port, host: config.hostname})

// соединение с БД
const MongoClient = require('mongodb').MongoClient

// ссылки на коллекции:

// registration users data
// {login, email, password}
let userListDB

// channel list
// {name, fullname, admin}
let channelsDB

// db object
let db

// список участников онлайн (их логины)
// lpeers[i] соответствует peers[i]
let lpeers = []
// список участников (ws)
let peers = []

// подсоединяемся к БД
MongoClient.connect('mongodb://' + config.hostname + ':' + config.mongod_port, function (err, dbController) {
  if (err) { throw err }
  userListDB = dbController.collection('users')
  channelsDB = dbController.collection('channels')

  db = dbController
})

/**
* должен вернуть false, если данный канал не был создан
*/
async function createNewChannel (name, fullname, senderLogin) {
	// добавляем канал в channels
  let res = true
  // проверяем, есть ли такой канал
  let list = await channelsDB.find({name: name}).toArray()
  if (list.length !== 0) {
    return false
  }
  // добавляем канал
  await channelsDB.insert({name: name, fullname: fullname}, {w: 1}, function (err) {
    if (err) { res = false }
  })
  if (!res) return false
	// создаем его личные collections: список пользователей и список сообщений
	// {login, type}
  let users = db.collection(name + '_users')
  // добавляем сразу же отправителя в качестве администратора
  users.insertOne({login: senderLogin, type: 'admin'}, {w: 1}, function (err) {
    if (err) { throw err }
  })
	// {message, from, time}
  db.createCollection(name + '_messages')
  return true
}

// {name, fullname, admin}
async function createNewChannelTask (event) {
  let name = event.name
  let fullname = event.fullname
  let admin = event.admin
  let result = await createNewChannel(name, fullname, admin)
  // отправить сообщение о создании канала отправителю
  sendResponseToSender(admin,
    {
      name: name,
      fullname: fullname,
      admin: admin,
      type: 'new_channel',
      success: result
    })
}

/**
* должен вернуть false, если данная запись не была добавлена
*/
async function addUserToChannel (userLogin, channelName) {
  let res = true
  let ch = await db.collection(channelName + '_users')
  console.log('userLogin: ' + userLogin)
	// проверить, что если добавляется существующий пользователь
  let list = await ch.find({login: userLogin}).toArray()
  if (list.length !== 0) {
    console.log('user exists')
    return false
  }
  await ch.insertOne({login: userLogin}, {w: 1}, function (err) {
    if (err) { res = false }
  })
  return res
}

// {user, channel, type}
async function addUserToChannelTask (event) {
  let userLogin = event.user
  let channelName = event.channel
  let result = await addUserToChannel(userLogin, channelName)
	// отправить сообщение о добавлении нового пользователя всем участникам данного канала
  console.log('send response adding user ' + result)

  sendResponseToOnlineChannelUsers(channelName,
		{user: userLogin, channel: channelName, type: 'add_user', success: result})
}

async function addMessageToChannel (mObj) {
  let ch = await db.collection(mObj.channel + '_messages')
  console.log(mObj)
  ch.insertOne({message: mObj.message, from: mObj.from, time: mObj.time}, {w: 1}, function (err) {
    if (err) { throw err }
  })
}

// {message, from, time, channel, type: 'message'}
function addMessageToChannelTask (event) {
  addMessageToChannel(event)
  // отправить новое сообщение всем участникам данного канала
  console.log('send response message')
  sendResponseToOnlineChannelUsersExceptFrom(event.channel,
    {
      message: event.message, from: event.from, 
      channel: event.channel, time: event.time, type: 'message'
    },
    event.from)
}

// return {name, fullname, admin}
async function getChannel(channelName) {
  // return array of all channels
  if (channelName === '*') {
    let chArr = await channelsDB.find().toArray()
    return chArr
  }
  else {
    let ch = await channelsDB.find({name: channelName}).toArray()
    return ch
  }
}

async function getChannelTask(mObj) {
  let channelName = mObj.name
  let res = await getChannel(channelName)
  // send list of all channels
  if (channelName == '*') {
    console.log('send channel ' + channelName)
    sendResponseToSender(mObj.from, {channels : res, type: 'get_channel'})
  }
  // send one channel
  else {
    if (res.length == 0) {
      console.log('err: there is no channels with name ' + channelName)
    }
    else if (res.length != 1) {
      console.log('err: there is more than one channels with name ' + channelName)
    }
    // correct
    else if (res.length == 1) {
      console.log('send channel ' + channelName)
    }
    sendResponseToSender(mObj.from, {channels : res, type: 'get_channel'})
  }
}
/*
  return all channel's messages
*/
async function getChannelMessages(channelName) {
  let ch = await db.collection(channelName + '_messages')
  let list = await ch.find().toArray()
  return list
}

// req: {channel, from, type : 'get_channel_messages'}
// resp:{messages, from, type}
async function getChannelMessagesTask(mObj) {
  let list = await getChannelMessages(mObj.channel)
  let fr = mObj.from
  let channelName = mObj.channel
  console.log('sending all ' 
    + channelName + ' channel messages to' + fr)
  sendResponseToSender(fr, 
    {channel: mObj.channel, messages: list, from: fr, type: mObj.type})
}




// проверка пользователя на предмет существования в базе данных
function existUser (user, callback) {
  userListDB.find({login: user}).toArray(function (error, list) {
    callback(list.length !== 0)
  })
}

function registerUser (user, email, password, callback) {
	// проверяем, есть ли такой пользователь
  existUser(user, function (exist) {
  	if (exist) {
  		callback(false)
  	}
  	// register new user
  	else {
  		userListDB.insertOne({login: user, email: email, password: password}, {w: 1}, function (err) {
    if (err) { throw err }
  })
      // возвращаем успешную регистрацию
    callback(true)
  	}
  })
}

function checkAuthorize (user, password, callback) {
	// проверяем, есть ли такой пользователь
  existUser(user, function (exist) {
    if (exist) {
      let i = lpeers.indexOf(user)
      if (i !== -1) {
        callback(false)
      } else {
  			// то найдем в БД записи о нем
        userListDB.find({login: user}).toArray(function (error, list) {
  				// проверяем пароль
          callback(list.pop().password === password)
        })
      }
    } else {
    	callback(false)
  	}
  })
}

function sendResponseToSender (sender, json) {
  let i = lpeers.indexOf(sender)
  // если он еще онлайн
  if (i !== -1) {
    peers[i].send(JSON.stringify(json))
  }
}

async function sendResponseToOnlineChannelUsers (channelName, json) {
  let ch = await db.collection(channelName + '_users')
  ch.find().toArray(function (error, list) {
    list.forEach(function (entry) {
      let i = lpeers.indexOf(entry.login)
      // отправляем всем, кто онлайн
      if (i !== -1) {
        console.log(entry.login)
        peers[i].send(JSON.stringify(json))
      }
    })
  })
}

async function sendResponseToOnlineChannelUsersExceptFrom (channelName, json, from) {
  let ch = await db.collection(channelName + '_users')
  ch.find().toArray(function (error, list) {
    list.forEach(function (entry) {
      let i = lpeers.indexOf(entry.login)
      // отправляем всем, кто онлайн, кроме отправителя
      if (i !== -1 && entry.login !== from) {
        peers[i].send(JSON.stringify(json))
      }
    })
  })
}

// при новом соединении
wss.on('connection', function (ws) {
  console.log('---------------')
  console.log('new connection')
	// проинициализируем переменные
  let login = ''
  let authorized = false

	// при входящем сообщении
  ws.on('message', function (message) {
		// получаем событие в пригодном виде
    let event = JSON.parse(message)

    // регистрация
    if (event.type === 'register') {
    	console.log('register type')

      registerUser(event.user, event.email, event.password, function (success) {
        console.log('registered new user: ' + success)
				// подготовка ответного события
        let returning = {type: 'register', success: success}

        ws.send(JSON.stringify(returning))
      })
    }

		// авторизация
    else if (event.type === 'authorize') {
      console.log('authorize type')
			// проверяем данные
      checkAuthorize(event.user, event.password, function (success) {
				// чтоб было видно в другой области видимости
        authorized = success
        console.log('success: ' + success)

				// подготовка ответного события
        let returning = {type: 'authorize', success: success}

				// если успех, то
        if (success) {
					// добавим к ответному событию список людей онлайн
          returning.online = lpeers

					// добавим самого человека в список людей онлайн
          lpeers.push(event.user)

					// добавим ссылку на сокет в список соединений
          peers.push(ws)

					// чтобы было видно в другой области видимости
          login = event.user

					//  если человек вышел
          ws.on('close', function () {
            console.log('closed for ' + login)
            peers.exterminate(ws)
            lpeers.exterminate(login)
          })
        }

				// ну и, наконец, отправим ответ
        ws.send(JSON.stringify(returning))
        console.log('authorized')
				// отправим старые сообщения новому участнику
				/*
        if (success) {
          sendNewMessages(ws)
        }
        */
      })
    } else {
      if (authorized) {
        //console.log('authorized')

        switch (event.type) {
					// если просто сообщение
          case 'message':
          	// {from, message, channel, time, type}
						// рассылаем его всем в данном канале
            // broadcast(login, event.message)
            addMessageToChannelTask(event)
            break
          case 'add_user':
          	// {user, channel, type}
          	// добавляем нового пользователя, если не существует
          	addUserToChannelTask(event)
            break
          case 'new_channel':
            // {name, fullname, admin}
            // создаем новый аккаунт, если не существует
            createNewChannelTask(event)
            break
          case 'get_channel':
            // {type, name, from}
            getChannelTask(event)
            break
          case 'get_channel_messages':
            // {channel, from, type}
            getChannelMessagesTask(event)
            break  
        }
      }
    }
  })
})

// функция отправки старых сообщений только что зашедшему участнику канала
async function sendOldMessages (ws, channelName) {
  let ch = await db.connection(channelName + '_messages')
  ch.find().toArray(function (error, messages) {
    if (error) { throw error }
    messages.forEach(function (message) {
      message.type = 'message'
      ws.send(JSON.stringify(message))
    })
  })
}

// убрать из массива элемент по его значению
Array.prototype.exterminate = function (value) {
  this.splice(this.indexOf(value), 1)
}

console.log('server started')
