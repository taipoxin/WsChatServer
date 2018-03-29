'use strict'
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

function log (message) {
  console.log(message)
  let d = new Date()
  let s = d.toUTCString()
  let dd = '' + d.getUTCMilliseconds()
  if (dd.length == 1) {
    dd = '0' + dd
  }
  if (dd.length == 2) { dd = '0' + dd }

  s = s.slice(0, s.length - 4) + ':' +
  dd + s.slice(s.length - 4)

  const fs = require('fs')
  fs.appendFile('log.txt',
    '[' + s + ']' + ': ' + message + '\r\n', function (err) {
      if (err) throw err
    })
}

// список участников онлайн (их логины)
// lpeers[i] соответствует peers[i]
let lpeers = []
// список участников (ws)
let peers = []

// подсоединяемся к БД
MongoClient.connect('mongodb://' + config.hostname + ':' + config.mongod_port, function (err, dbController) {
  if (err) {
    log('Error while connecting mongodb: ' + err)
    throw err
  }
  userListDB = dbController.collection('users')
  channelsDB = dbController.collection('channels')

  db = dbController
})

function sendObjectIfOpen (ws, js_object) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(js_object))
    return true
  }
  return false
}

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

  log('creation new channel ' + name +
    ' from ' + admin + ' status: ' + result)
  // log channel members

  if (!result) {
    let ch = await db.collection(name + '_users')
    let list = await ch.find().toArray()
    log('user list of ' + name + ':')
    log(list)
  }

  sendResponseToSender(admin,
    {name: name,
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
  log('userLogin: ' + userLogin)
	// проверить, что если добавляется существующий пользователь
  let list = await ch.find({login: userLogin}).toArray()
  if (list.length !== 0) {
    log('user exists')
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
  log('send response adding user ' + result)

  sendResponseToOnlineChannelUsers(channelName,
		{user: userLogin, channel: channelName, type: 'add_user', success: result})
}

async function addMessageToChannel (mObj) {
  let ch = await db.collection(mObj.channel + '_messages')
  log(mObj)
  ch.insertOne({message: mObj.message, from: mObj.from, time: mObj.time}, {w: 1}, function (err) {
    if (err) { throw err }
  })
}

// {message, from, time, channel, type: 'message'}
function addMessageToChannelTask (event) {
  addMessageToChannel(event)
  // отправить новое сообщение всем участникам данного канала
  log('send response message')
  sendResponseToOnlineChannelUsersExceptFrom(event.channel,
    {
      message: event.message,
      from: event.from,
      channel: event.channel,
      time: event.time,
      type: 'message'
    },
    event.from)
}

// return {name, fullname, admin}
async function getChannel (channelName) {
  // return array of all channels
  if (channelName === '*') {
    let chArr = await channelsDB.find().toArray()
    return chArr
  } else {
    let ch = await channelsDB.find({name: channelName}).toArray()
    return ch
  }
}

async function getChannelTask (mObj) {
  let channelName = mObj.name
  let res = await getChannel(channelName)
  // send list of all channels
  if (channelName == '*') {
    log('send channel ' + channelName)
    sendResponseToSender(mObj.from, {channels: res, type: 'get_channel'})
  }
  // send one channel
  else {
    if (res.length == 0) {
      log('err: there is no channels with name ' + channelName)
    } else if (res.length != 1) {
      log('err: there is more than one channels with name ' + channelName)
    }
    // correct
    else if (res.length == 1) {
      log('send channel ' + channelName)
    }
    sendResponseToSender(mObj.from, {channels: res, type: 'get_channel'})
  }
}
/*
  return all channel's messages
  if (channel is not exist, return type 'get_channel_messages_not_exist')
*/
async function getChannelMessages (channelName) { // TODO: проверить, сущ ли канал
  let ch = await db.collection(channelName + '_messages')
  let list = await ch.find().toArray()
  return list
}

// req: {channel, from, type : 'get_channel_messages'}
// resp:{channel, messages, from, type}
async function getChannelMessagesTask (mObj) {
  let ch = await channelsDB.find({name: mObj.channel}) // TODO: test
  if (ch !== undefined) {
    let list = await getChannelMessages(mObj.channel)
    let fr = mObj.from
    let channelName = mObj.channel
    log('sending all ' +
      channelName + ' channel messages to' + fr)
    sendResponseToSender(fr,
      {channel: mObj.channel, messages: list, from: fr, type: mObj.type})
  }
  else {
    log('error get messages: there is no channel with name ' + mObj.channel)
    let fr = mObj.from
    sendResponseToSender(fr,
      {channel: mObj.channel, from: fr, type: 'get_channel_messages_not_exist'})
  }

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
    sendObjectIfOpen(peers[i], json)
  }
}

async function sendResponseToOnlineChannelUsers (channelName, json) {
  let ch = await db.collection(channelName + '_users')
  ch.find().toArray(function (error, list) {
    list.forEach(function (entry) {
      let i = lpeers.indexOf(entry.login)
      // отправляем всем, кто онлайн
      if (i !== -1) {
        log(entry.login)
        sendObjectIfOpen(peers[i], json)
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
        sendObjectIfOpen(peers[i], json)
      }
    })
  })
}

// при новом соединении
wss.on('connection', function (ws) {
  log('---------------')
  log('new connection')
  log('---------------')
	// проинициализируем переменные
  let login = ''
  let authorized = false

	// при входящем сообщении
  ws.on('message', function (message) {
		// получаем событие в пригодном виде
    let event = JSON.parse(message)

    // регистрация
    if (event.type === 'register') {
    	log('register type')

      registerUser(event.user, event.email, event.password, function (success) {
        log('registered new user: ' + success)
				// подготовка ответного события
        let returning = {type: 'register', success: success}
        sendObjectIfOpen(ws, returning)
      })
    }

		// авторизация
    else if (event.type === 'authorize') {
      log('authorize type')
			// проверяем данные
      checkAuthorize(event.user, event.password, function (success) {
				// чтоб было видно в другой области видимости
        authorized = success
        log('success: ' + success)

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
            log('closed for ' + login)
            peers.exterminate(ws)
            lpeers.exterminate(login)
          })
        }

				// ну и, наконец, отправим ответ
        sendObjectIfOpen(ws, returning)
        log('authorized')
				// отправим старые сообщения новому участнику
				/*
        if (success) {
          sendNewMessages(ws)
        }
        */
      })
    } else {
      if (authorized) {
        switch (event.type) {
					// если просто сообщение
          case 'message':
          	// {from, message, channel, time, type}
						// рассылаем его всем в данном канале
            log('received as message: ' + message)
            addMessageToChannelTask(event)
            break
          case 'add_user':
          	// {user, channel, type}
          	// добавляем нового пользователя, если не существует
            log('received as add_user: ' + message)
          	addUserToChannelTask(event)
            break
          case 'new_channel':
            // {name, fullname, admin}
            // создаем новый аккаунт, если не существует
            log('received as new_channel: ' + message)
            createNewChannelTask(event)
            break
          case 'get_channel':
            // req:  {type, name, from}
            // resp: {from, channels, type : 'get_channel'}
            log('received as get_channel: ' + message)
            getChannelTask(event)
            break
          case 'get_channel_messages':
            // {channel, from, type}
            log('received as get_channel_messages: ' + message)
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
      sendObjectIfOpen(ws, message)
    })
  })
}

// убрать из массива элемент по его значению
Array.prototype.exterminate = function (value) {
  this.splice(this.indexOf(value), 1)
}

log('_______________')
log('server started')
log('_______________')
