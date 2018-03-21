const path = require('path')
// server config params
const config = require('./config')

// создаем сервер
const WebSocketServer = require('ws').Server
const wss = new WebSocketServer({port: config.ws_port, host: config.hostname})

// соединение с БД
const MongoClient = require('mongodb').MongoClient

// ссылки на коллекции

// registration users data
// {login, email, password}
var userListDB

// contains group messages
// {message, from, time}
var chatDB

// channel list
// {name, fullname}
var channelsDB

var dbController

// подсоединяемся к БД
MongoClient.connect('mongodb://' + config.hostname + ':' + config.mongod_port, function (err, db) {
  if (err) { throw err }

  userListDB = db.collection('users')
	// pattern for chat
  chatDB = db.collection('chat')

  channelsDB = db.collection('channels')

  dbController = db
})

function createNewChannel (name, fullname) {
	// добавляем канал в channels

  channelsDB.insert({name: name, fullname: fullname}, {w: 1}, function (err) {
    if (err) { throw err }
  })

	// создаем его личные collections: список пользователей и список сообщений
	// {login}
  dbController.createCollection(name + '_users')
	// {message, from, time}
  dbController.createCollection(name + '_messages')
}

/**
* должен вернуть false, если данная запись не была добавлена
*/
async function addUserToChannel (userLogin, channelName) {
  let res = true
	// проверить, что если добавляется существующий пользователь
  let ch = await db.collection('channelName' + '_users')
  ch.insert({login: userLogin}, {w: 1}, function (err) {
    if (err) { res = false }
  })
  return res
}

async function addUserToChannelTask (userLogin, channelName) {
  let result = await addUserToChannel(userLogin, channelName)
	// отправить сообщение о добавлении нового пользователя всем участникам данного канала
  sendResponseToOnlineChannelUsers(channelName,
		{user: userLogin, channel: channelName, type: 'add_user', success: result})
}

async function addMessageToChannel (mObj, channelName) {
  let ch = await db.collection(channelName + '_messages')
  ch.insert({message: mObj.message, from: mObj.from, time: mObj.time}, {w: 1}, function (err) {
    if (err) { throw err }
  })
}

async function addMessageToChannel (mObj) {
  var channelName = mObj.channel
  let ch = await db.collection(channelName + '_messages')
  ch.insert({message: mObj.message, from: mObj.from, time: mObj.time}, {w: 1}, function (err) {
    if (err) { throw err }
  })
}

function showCollections () {
  dbController.collections(function (err, items) {
    console.log(items)
  })

	// console.log(dbController)
}

// список участников онлайн (их логины)
// lpeers[i] соответствует peers[i]
var lpeers = []
// список участников (ws)
var peers = []

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
  		userListDB.insert({login: user, email: email, password: password}, {w: 1}, function (err) {
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
			// то найдем в БД записи о нем
      userListDB.find({login: user}).toArray(function (error, list) {
				// проверяем пароль
        callback(list.pop().password === password)
      })
    } else {
    	callback(false)
  	}
  })
}

/*
// функция отправки сообщения всем
function broadcast (by, message) {
	// запишем в переменную, чтоб не расходилось время
  var time = new Date().getTime()

	// отправляем по каждому соединению
  for (i = 0; i < peers.length; i++) {
  	if (lpeers[i] != by) {
  		peers[i].send(JSON.stringify({
	      type: 'message',
	      message: message,
	      from: by,
	      time: time
	    }))
  	}
  }
	// сохраняем сообщение в истории
  chatDB.insert({message: message, from: by, time: time}, {w: 1}, function (err) {
    if (err) { throw err }
  })
}
*/

async function sendResponseToOnlineChannelUsers (channelName, json) {
  var ch = await dbController.connection(channelName + '_users')
	 ch.find().toArray(function (error, list) {
   list.forEach(function (entry) {
     var i = lpeers.indexOf(entry)
      // отправляем всем, кто онлайн
     peers[i].send(json)
   })
 })
}

async function sendResponseToOnlineChannelUsersExceptFrom (channelName, json, from) {
	 var ch = await dbController.connection(channelName + '_users')
	 ch.find().toArray(function (error, list) {
   list.forEach(function (entry) {
     var i = lpeers.indexOf(entry)
      // отправляем всем, кто онлайн, кроме отправителя
     if (i != -1 && entry != from) {
      	peers[i].send(json)
     }
   })
 })
}

// функция отправки сообщения всем онлайн участникам нужного канала
function broadcastMessage (event) {
  let js = JSON.stringify({
    type: 'message',
    message: event.message,
    from: event.from,
    time: event.time,
    channel: event.channel
  })

  sendResponseToOnlineChannelUsersExceptFrom(event.channel, js, event.from)
	// сохраняем сообщение в истории
  addMessageToChannel(event)
}

// при новом соединении
wss.on('connection', function (ws) {
  console.log('new connection')
	// проинициализируем переменные
  var login = ''
  var authorized = false

	// при входящем сообщении
  ws.on('message', function (message) {
		// получаем событие в пригодном виде
    var event = JSON.parse(message)

    // регистрация
    if (event.type === 'register') {
    	console.log('register type')

      registerUser(event.user, event.email, event.password, function (success) {
        console.log('registered new user: ' + success)
				// подготовка ответного события
        var returning = {type: 'register', success: success}

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
        var returning = {type: 'authorize', success: success}

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
            peers.exterminate(ws)
            lpeers.exterminate(login)
          })
        }

				// ну и, наконец, отправим ответ
        ws.send(JSON.stringify(returning))

				// отправим старые сообщения новому участнику
				/*
        if (success) {
          sendNewMessages(ws)
        }
        */
      })
    } else {
      if (authorized) {
        console.log('authorized')

        switch (event.type) {
					// если просто сообщение
          case 'message':
          	// {from, message, channel, time, type}
						// рассылаем его всем
            // broadcast(login, event.message)
            broadcastMessage(event)
            break
          case 'add_user':
          	// {user, channel, type}
          	// приходит сообщение с пользователем,
          	// которого нужно добавить в определенный канал
          	// а также отправить ответ о добавлении

            break
        }
      }
    }
  })
})

// функция отправки старых сообщений только что зашедшему участнику канала
async function sendOldMessages (ws, channelName) {
  var ch = await dbController.connection(channelName + '_messages')
  ch.find().toArray(function (error, messages) {
    if (error) { throw error }
    messages.forEach(function (message) {
      message.type = 'message'
      ws.send(JSON.stringify(message))
    })
  })
}

/*
// функция отправки старых сообщений только что зашедшему участнику чата
function sendNewMessages (ws) {
  chatDB.find().toArray(function (error, entries) {
    if (error) { throw error }
    entries.forEach(function (entry) {
      entry.type = 'message'
      ws.send(JSON.stringify(entry))
    })
  })
}
*/

// убрать из массива элемент по его значению
Array.prototype.exterminate = function (value) {
  this.splice(this.indexOf(value), 1)
}

const readline = require('readline')

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

rl.question('', (answer) => {
	// console.log(`Thank you for your valuable feedback: ${answer}`);

	// createNewChannel('chichichiii')
	// showCollections()
  rl.close()
})
