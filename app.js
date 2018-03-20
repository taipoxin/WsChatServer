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

// подсоединяемся к БД
MongoClient.connect('mongodb://' + config.hostname + ':' + config.mongod_port, function (err, db) {
  if (err) { throw err }

  userListDB = db.collection('users')
  chatDB = db.collection('chat')
})

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
				/**/
        if (success) {
          sendNewMessages(ws)
        }
        /**/
      })
    } else {
			// если человек не авторизирован, то игнорим его
      if (authorized) {
        console.log('authorized')
				// проверяем тип события
        switch (event.type) {
					// если просто сообщение
          case 'message':
						// рассылаем его всем
            broadcast(login, event.message)
            break
					// если сообщение о том, что он печатает сообщение
          case 'type':
						// то пока я не решил, что делать в таких ситуациях
            break
        }
      }
    }
  })
})

// функция отправки старых сообщений новому участнику чата
function sendNewMessages (ws) {
  chatDB.find().toArray(function (error, entries) {
    if (error) { throw error }
    entries.forEach(function (entry) {
      entry.type = 'message'
      ws.send(JSON.stringify(entry))
    })
  })
}

// убрать из массива элемент по его значению
Array.prototype.exterminate = function (value) {
  this.splice(this.indexOf(value), 1)
}
