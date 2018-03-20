const path = require('path')
const express = require('express')
const app = express()
const cons = require('consolidate')

// server config params
const config = require('./config')



// UI http part (for tests)
app.use(express.static(path.join(__dirname, '/view')))

app.engine('html', cons.mustache)

// установить движок рендеринга
app.set('view engine', 'html')

app.get('/', function (req, res) {
  res.render('index')
})
// Запустим сервер
app.listen(config.http_port, config.hostname, function (err) {
  if (err) throw err
  console.log(`Running server at port ` + config.http_port)
})
// end UI http part




// создаем сервер
var WebSocketServer = require('ws').Server
var wss = new WebSocketServer({port: config.ws_port, host: config.hostname})

// соединение с БД
var MongoClient = require('mongodb').MongoClient
var format = require('util').format

// ссылки на коллекции
var userListDB, chatDB

// подсоединяемся к БД
MongoClient.connect('mongodb://' +config.hostname + ':' + config.mongod_port, function (err, db) {
  if (err) { throw err }

  userListDB = db.collection('users')
  chatDB = db.collection('chat')
})

// список участников чата (их логины)
var lpeers = []
// список участников (ws)
var peers = []

// проверка пользователя на предмет существования в базе данных
function existUser (user, callback) {
  userListDB.find({login: user}).toArray(function (error, list) {
    callback(list.length !== 0)
  })
}
// эта функция отвечает целиком за всю систему аккаунтов
function checkUser (user, password, callback) {
	// проверяем, есть ли такой пользователь
  existUser(user, function (exist) {
    if (exist) {
			// то найдем в БД записи о нем
      userListDB.find({login: user}).toArray(function (error, list) {
				// проверяем пароль
        callback(list.pop().password === password)
      })
    } else {
			// если пользователя нет, то регистрируем его
      userListDB.insert({login: user, password: password}, {w: 1}, function (err) {
        if (err) { throw err }
      })
			// не запрашиваем авторизацию, пускаем сразу
      callback(true)
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
  var registered = false

	// при входящем сообщении
  ws.on('message', function (message) {
		// получаем событие в пригодном виде
    var event = JSON.parse(message)

		// если человек хочет авторизироваться, проверим его данные
    if (event.type === 'authorize') {
      console.log('authorize type')
			// проверяем данные
      checkUser(event.user, event.password, function (success) {
				// чтоб было видно в другой области видимости
        registered = success
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
      if (registered) {
        console.log('registered')
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
