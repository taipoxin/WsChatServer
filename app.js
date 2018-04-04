'use strict'
// server config params
const config = require('./config')

const WebSocketServer = require('ws').Server
const wss = new WebSocketServer({port: config.ws_port, host: config.hostname})

const MongoClient = require('mongodb').MongoClient


// collection links

// registration users data
// {login, email, password}
let userListDB

// channel list
// {name, fullname, admin}
let channelsDB

// db object
let db
const fs = require('fs')
const async = require('async')
const utils = require('utils')
let MAX_OPEN_FILES = 255
let __writeQueue = async.queue(function (task, callback) {
        task(callback);
    }, MAX_OPEN_FILES);

let __log = function (filename, text) {
  return function (callback) {
    //var s = utils.digitime() + ' ' + text + '\n';

    fs.open(filename, "a", 0x1a4, function (error, file_handle) {
      if (!error) {
        fs.write(file_handle, text, null, 'utf8', function (err) {
          if (err) {
            console.log(filename + ' ' + err);
          }
          fs.close(file_handle, function () {
            callback();
          });                        
        });
      }
      else {
        console.log(filename + ' ' + error);
        callback();
      }
    });
  };
};


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

  let file = 'log.txt'
  let mess = '[' + s + ']' + ': ' + message + '\r\n'
  __writeQueue.push(__log(file, mess));
  
  /*
  fs.appendFile('log.txt',
    '[' + s + ']' + ': ' + message + '\r\n', function (err) {
      if (err) throw err
    }
  )
  */

}

// list of online users
// lpeers[i] corresponds to peers[i]
let lpeers = [] // logins
let peers = []  // connection objects


MongoClient.connect('mongodb://' + config.hostname + ':' + config.mongod_port, function (err, dbController) {
  if (err) {
    log('Error while connecting mongodb: ' + err)
    throw err
  }
  userListDB = dbController.collection('users')
  channelsDB = dbController.collection('channels')

  db = dbController
})

// stringify function with circular reference checking
// see: https://stackoverflow.com/questions/11616630
function stringify(object) {
  let cache = []
  let js = JSON.stringify(object, function(key, value) {
      if (typeof value === 'object' && value !== null) {
          if (cache.indexOf(value) !== -1) {
              // Circular reference found, discard key
              return
          }
          // Store value in our collection
          cache.push(value)
      }
      return value
  })
  cache = null // Enable garbage collection
  return js
}

function sendObjectIfOpen (ws, js_object) {
  if (ws.readyState === 1) {
    ws.send(stringify(js_object))
    return true
  }
  return false
}


// should return false if channel is has not been created
async function createNewChannel (name, fullname, senderLogin) {
  let res = true
  // check if channel exists
  let list = await channelsDB.find({name: name}).toArray()
  if (list.length !== 0) {
    return false
  }

  await channelsDB.insert({name: name, fullname: fullname}, {w: 1}, function (err) {
    if (err) { res = false }
  })
  if (!res) return false
	// create channel collections
	
  // {login, type}
  let users = db.collection(name + '_users')
  // set sender as administrator
  users.insertOne({login: senderLogin, type: 'admin'}, {w: 1}, function (err) {
    if (err) { throw err }
  })
	// {message, from, time}
  db.createCollection(name + '_messages')
  return true
}

function logList(prevMessage, list, name) {
  let idx = 0
  list.forEach(x => {
    if (idx === 0) {
      log(prevMessage)
    }
    log(name + '[' + idx + ']:')
    log(stringify(x))
    idx++
  })
}

// {name, fullname, admin}
async function createNewChannelTask (event) {
  let name = event.name
  let fullname = event.fullname
  let admin = event.admin
  let result = await createNewChannel(name, fullname, admin)

  log('creation new channel ' + name +
    ' from ' + admin + ' status: ' + result)

  // show channel members if it has been existed
  if (!result) {
    let ch = await db.collection(name + '_users')
    let list = await ch.find()
    logList('user list of ' + name + ':', list, name)

  }

  sendResponseToSender(admin,
    {name: name,
      fullname: fullname,
      admin: admin,
      type: 'new_channel',
      success: result
    })
}

// should return false if user is has not been added
async function addUserToChannel (sender, userLogin, channelName) {
  let res = true
  let ch = await db.collection(channelName + '_users')
  log('userLogin: ' + userLogin)
	// check user existence
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

// {sender, user, channel, type}
async function addUserToChannelTask (event) {
  let sender = event.sender
  let userLogin = event.user
  let channelName = event.channel
  let result = await addUserToChannel(sender, userLogin, channelName)
  // send response about adding new user to all members of the channel
  log('send response adding user ' + result)

  sendResponseToOnlineChannelUsers(channelName,
		{sender: sender, user: userLogin, channel: channelName, type: 'add_user', success: result})
}

async function addMessageToChannel (mObj) {
  let ch = await db.collection(mObj.channel + '_messages')
  ch.insertOne({message: mObj.message, from: mObj.from, time: mObj.time}, {w: 1}, function (err) {
    if (err) { throw err }
  })
}

// {message, from, time, channel, type: 'message'}
function addMessageToChannelTask (event) {
  addMessageToChannel(event)
  // broadcast message
  log('send response message to others except ' + event.from)
  let resp = {
    message: event.message,
    from: event.from,
    channel: event.channel,
    time: event.time,
    type: 'message'
  }
  log(stringify(resp))
  sendResponseToOnlineChannelUsersExceptFrom(event.channel, resp, event.from)
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

// return all channel's messages
// if channel is not exist, return type 'get_channel_messages_not_exist'
async function getChannelMessages (channelName, fromTime) { // TODO: проверить, сущ ли канал
  let ch = await db.collection(channelName + '_messages')
  let list
  // load all
  if (fromTime == 0) {
    list = await ch.find().toArray()
  }
  // load more than
  else {
    list = await ch.find({time: { $gt: fromTime } }).toArray()
  }
  //log(list)
  return list
}

// req: {channel, from, time, type : 'get_channel_messages'}
// resp:{channel, messages, from, time, type}
async function getChannelMessagesTask (mObj) {
  let ch = await channelsDB.find({name: mObj.channel}) // TODO: test
  if (ch !== undefined) {
    let list = await getChannelMessages(mObj.channel, mObj.time)
    let fr = mObj.from
    let channelName = mObj.channel
    log('sending ' + list.length +  ' ' +
      channelName + ' channel messages to ' + fr)
    sendResponseToSender(fr,
      {channel: mObj.channel, messages: list, from: fr, type: mObj.type})
  } else {
    log('error get messages: there is no channel with name ' + mObj.channel)
    let fr = mObj.from
    sendResponseToSender(fr,
      {channel: mObj.channel, from: fr, type: 'get_channel_messages_not_exist'})
  }
}

// req: {sender, type : 'get_online_users'}
// resp:{sender, users, type}
function getOnlineUsersTask(mObj) {
  sendResponseToSender(mObj.sender, {sender : mObj.sender, users: lpeers, type : mObj.type})
}


function isUserExists(user) {
  return userListDB.findOne({login: user})
}

async function registerUser (user, email, password, callback) {
  if (await isUserExists(user)) {
    callback(false)
  }
  else {
    let err = await userListDB.insertOne(
      {login: user, email: email, password: password}, {w: 1})
    if (err) {
      log('inserting user err: ' + err)
      callback(false)
    }
    callback(true)
  }
}

// callback true if user exist and password correct
// otherwise - false
async function checkUserAuthorize (user, password, callback) {
  if (await isUserExists(user)) {
    let i = lpeers.indexOf(user)
    // if already authorised - deny access
    if (i !== -1) {
      callback(false)
    // return checking password
    } else {
      let u = await userListDB.findOne({login: user})
      callback(u.password === password)
    }
  }
  // not exist in db
  else {
    callback(false)
  }
}


function sendResponseToSender (sender, json) {
  let i = lpeers.indexOf(sender)
  // only if online now
  if (i !== -1) {
    sendObjectIfOpen(peers[i], json)
  }
}

async function sendResponseToOnlineChannelUsers (channelName, json) {
  let ch = await db.collection(channelName + '_users')
  ch.find().toArray(function (error, list) {
    log('online now in ' + channelName + ':')
    list.forEach(function (entry) {
      let i = lpeers.indexOf(entry.login)
      // for online members only
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
      // for online except sender
      if (i !== -1 && entry.login !== from) {
        sendObjectIfOpen(peers[i], json)
      }
    })
  })
}

let connectionCount = 0

// every new connection to ws
wss.on('connection', function (ws) {
  log('---------------')
  log('new connection')
  log('---------------')
  connectionCount++

	// start init
  let login = ''
  let authorized = false

  //  on exit
  ws.on('close', function () {
    connectionCount--
    if (authorized) {
      peers.exterminate(ws)
      lpeers.exterminate(login)
      log('closed for ' + login + ', online now: ' + '[' + lpeers + ']')
    }
    else {
      log('disconnected')
    }
    log('connection count: ' + connectionCount)
  })

	// on any request
  ws.on('message', function (message) {
    let event = JSON.parse(message)

    if (event.type === 'register') {
    	log('register type')
      // save if not exists
      registerUser(event.user, event.email, event.password, function (success) {
        log('registered new user: ' + success)
				
        // preparing response
        let returning = {type: 'register', success: success}
        sendObjectIfOpen(ws, returning)
      })
    }

    else if (event.type === 'authorize') {
      log('authorize type')
			// check data and existence
      checkUserAuthorize(event.user, event.password, function (success) {
				
        authorized = success
        log('success: ' + success)

				// preparing response
        let returning = {type: 'authorize', success: success}

				// if correct data
        if (success) {
          log('authorized')
					
          // add user to lpeers
          lpeers.push(event.user)

          // add connection to list
          peers.push(ws)
          
          // list of online users
          returning.online = lpeers
          login = event.user

          log('online now: ' + '[' + returning.online + ']')
   
        }
				// send request
        sendObjectIfOpen(ws, returning)
      })
    } else {
      // requests handled only for authorised user
      if (authorized) {
        switch (event.type) {
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
            // {channel, from, time, type}
            log('received as get_channel_messages: ' + message)
            getChannelMessagesTask(event)
            break
          case 'get_online_users':
            // return all online users
            // {sender, type}
            log('received as get_online_users: ' + message)
            getOnlineUsersTask(event)
            break
        }
      }
    }
  })
})

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

// remove element from arr by it value
Array.prototype.exterminate = function (value) {
  this.splice(this.indexOf(value), 1)
}

log('_______________')
log('server started')
log('_______________')
