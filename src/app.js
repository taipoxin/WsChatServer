'use strict'
// server config params
const config = require('./config')
const log = require('./logging')


let wsPort = process.env.REMOTE_WS_PORT || config.ws_port 
let mongodbURL = process.env.REMOTE_MONGODB_URL || config.mongodb_string

const WebSocket = require('ws')
const fs = require('fs')
const https = require('https')
var express = require('express')

var privateKey  = fs.readFileSync('./key.pem', 'utf8')
var certificate = fs.readFileSync('./certificate.pem', 'utf8')

var credentials = {
  key: privateKey, 
  cert: certificate, 
  passphrase: config.passphrase,
  requestCert: true,
  rejectUnauthorized: false
}

var app = express()

//... bunch of other express stuff here ...

//pass in your express app and credentials to create an https server
var httpsServer = https.createServer(credentials, app)
httpsServer.listen(wsPort)


log('https server started on ' + wsPort + ' port')



const wss = new WebSocket.Server({server:  httpsServer })
//log(wss)


const MongoClient = require('mongodb').MongoClient

const utils = require('./utils')



// collection links

// registration users data
// {login, email, password}
let userListDB

// channel list
// {name, fullname, admin}
let channelsDB

// db object
let db

// list of online users
// lpeers[i] corresponds to peers[i]
let lpeers = [] // logins
let peers = []  // connection objects

MongoClient.connect('mongodb://' + mongodbURL, {uri_decode_auth: true}, function (err, dbController) {
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
    ws.send(utils.stringify(js_object))
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
  let users = await db.collection(name + '_users')
  // set sender as administrator
  users.insertOne({login: senderLogin, type: 'admin'}, {w: 1}, function (err) {
    if (err) { throw err }
  })
  let user_channels = await db.collection(senderLogin + '_channels')
  // type : admin - reference, that user is admin in the channel
  user_channels.insertOne({name: name, fullname: fullname, type: 'admin'}, {w: 1}, function (err) {
    if (err) { throw err }
  })
	// {message, from, time}
  db.createCollection(name + '_messages')
  return true
}

// {name, fullname, admin}
async function createNewChannelTask (event) {
  let result = await createNewChannel(event.name, event.fullname, event.admin)

  log('creation new channel ' + event.name +
    ' from ' + event.admin + ' status: ' + event.result)

  // show channel members if it has been existed
  if (!result) {
    let ch = await db.collection(event.name + '_users')
    let list = await ch.find()
    utils.logList('user list of ' + event.name + ':', list, event.name)
  }

  sendResponseToSender(event.admin,
    {name: event.name,
      fullname: event.fullname,
      admin: event.admin,
      type: event.type,
      success: result
    })
}

// should return false if user is has not been added
async function addUserToChannel (sender, userLogin, channelName, channelFullname) {
  let res = true
  let ch = await db.collection(channelName + '_users')
	// check user existence
  let list = await ch.find({login: userLogin}).toArray()
  if (list.length !== 0) {
    log('user ' + userLogin + ' exists')
    return false
  }
  if (channelFullname == null) {
    log('get fullname from db for' + channelName)
    let list = await channelsDB.find({name: channelName}).toArray()
    channelFullname = list[0].fullname
  }
  let user_channels = await db.collection(userLogin + '_channels')
  user_channels.insertOne({name: channelName, fullname: channelFullname}, {w: 1}, function (err) {
    if (err) { throw err }
  })

  await ch.insertOne({login: userLogin}, {w: 1}, function (err) {
    if (err) { res = false }
  })

  return res
}

// req: {sender, user, channel, type: 'add_user'}
// resp: {sender, user, channel, success, type: 'add_user'}
// if user exists or adding error, should return response success: {false} to sender
// else add user and return true, resend message to all users
async function addUserToChannelTask (event) {
  let result = await addUserToChannel(event.sender, event.user, event.channel, event.fullname)
  log('send response adding user: ' + result)
  event.success = result
  if (result) {
    // send response about adding new user to all members of the channel
    sendResponseToOnlineChannelUsers(event.channel, event)
  }
  // send bad response only to sender
  else {
    sendResponseToSender(event.sender, event)
  }
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
  log(utils.stringify(resp))
  sendResponseToOnlineChannelUsersExceptFrom(event.channel, resp, event.from)
}

// return {name, fullname, admin}
async function getChannel (from, channelName) {
  // return array of all channels for the user
  if (channelName === '*') {
    let user_channels = await db.collection(from + '_channels')
    let chArr = await user_channels.find().toArray()
    return chArr
  } else {
    let ch = await channelsDB.find({name: channelName}).toArray()
    return ch
  }
}

async function getChannelTask (mObj) {
  let channelName = mObj.name
  let res = await getChannel(mObj.from, channelName)
  // send list of all channels filtered for the user
  let user_counts = []
  for (const channel of res) {
    let userDb = await db.collection(channel.name + '_users')
    let list = await userDb.find().toArray()
    log(channel.name + ' user_count is: ' + list.length)
    user_counts.push(list.length)
  }
  sendResponseToSender(mObj.from, {channels: res, user_counts: user_counts, type: 'get_channel'})
  log('sended')
}

// return all channel's messages
// if channel is not exist, return type 'get_channel_messages_not_exist'
async function getChannelMessages (channelName, fromTime) {
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
  // log(list)
  return list
}

// req: {channel, from, time, type : 'get_channel_messages'}
// resp:{channel, messages, from, time, type}
async function getChannelMessagesTask (mObj) {
  let ch = await channelsDB.find({name: mObj.channel})
  if (ch !== undefined) {
    let list = await getChannelMessages(mObj.channel, mObj.time)
    let fr = mObj.from
    let channelName = mObj.channel
    log('sending ' + list.length + ' ' +
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
function getOnlineUsersTask (mObj) {
  sendResponseToSender(mObj.sender, {sender: mObj.sender, users: lpeers, type: mObj.type})
}

async function getChannelUsers (channelName) {
  let users = await db.collection(channelName + '_users')
  let userList = await users.find().toArray()
  return userList
}

// req: {sender, channel, type}
// resp:{sender, channel, users, type}
async function getChannelUsersTask (mObj) {
  let userList = await getChannelUsers(mObj.channel)
  mObj.users = userList
  sendResponseToSender(mObj.sender, mObj)
}

function isUserExists (user) {
  return userListDB.findOne({login: user})
}

async function registerUser (user, email, password, callback) {
  if (await isUserExists(user)) {
    log('user already exists')
    callback(false)
  } else {
    let result = await userListDB.insertOne(
      {login: user, email: email, password: password}, {w: 1})
    if (result) {
      log('inserting user result '+ result)
      db.createCollection(user + '_channels')
      callback(true)
    } else {
      log('inserting user err: ' + err)
      callback(false)
    }
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
    } else {
      log('disconnected unauthorized')
    }
    log('connection count: ' + connectionCount)
  })

	// on any request
  ws.on('message', function (message) {
    let event = {}

    try {
        event = JSON.parse(message)
    } catch(e) {
        log('bad message: ' + e) // error in the above string
    }

    if (event.type === 'register') {
    	log('register type')
      // save if not exists
      registerUser(event.user, event.email, event.password, function (success) {
        log('registered new user: ' + success)

        // preparing response
        let returning = {type: 'register', success: success}
        sendObjectIfOpen(ws, returning)
      })
    } else if (event.type === 'authorize') {
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
          	// req: {sender, user, channel, type}
            // resp: {sender, user, channel, success, type}
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
            // resp: {from, channels, users, type : 'get_channel'}
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
          case 'get_channel_users':
            // return list of users of the channel
            // req: {sender, channel, type}
            // resp:{sender, channel, users, type}
            log('received as get_channel_users: ' + message)
            getChannelUsersTask(event)
            break
        }
      }
      else {
        log('invalid message: ' + message)
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
