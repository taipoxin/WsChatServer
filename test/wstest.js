'use strict'
const config = require('../config')
const mocha = require('mocha')
const chai = require('chai')
const WebSocket = require('ws')

let expect = chai.expect

function logTest () {
  let d = new Date()
  let s = d.toUTCString()
  let dd = '' + d.getUTCMilliseconds()
  if (dd.length == 1) { dd = '0' + dd }
  if (dd.length == 2) { dd = '0' + dd }

  s = s.slice(0, s.length - 4) + ':' +
  dd + s.slice(s.length - 4)

  const fs = require('fs')
  fs.appendFile('test/testlog.txt',
    '[' + s + ']' + ':  another test\r\n', function (err) {
      if (err) throw err
    })
}
logTest()

describe('ws tests', () => {
  function onOpen (client, req) {
    let timeout_t = 10
    let times = 100
    let i = 0;
    // sync loop for 5 tries to send request to ws
    (function loop () {
      if (i === times + 10) { return }
      if (i++ > times) {
        console.log('sending failed')
        return
      };
      setTimeout(function () {
        if (client.readyState === 1) {
          console.log('sending')
          client.send(JSON.stringify(req))
          i = times + 10
        }
        loop()
      }, timeout_t)
    })()
  }

  function createPatternConnection (done, on_Message, on_Open, clientName, json, otherCheckFunc) {
    let name = clientName
    if (clientName === undefined) {
      name = 'client0'
    }

    let ws_source = 'ws://' + config.hostname + ':' + config.ws_port
    let client = new WebSocket(ws_source)

    client.onclose = (e) => { console.log('connection closed') }
    client.onerror = (e) => { console.log('connection aborted') }
    client.onopen = on_Open(client, name, done)

    client.on('message', (message) => {
      on_Message(done, message, client, name, json, otherCheckFunc)
    })
    return client
  }

  function onOpenAuth (client, name) {
    let auth = {user: name, password: '12345', type: 'authorize'}
    onOpen(client, auth)
  }

  // reg user after connect
  function onOpenReg (client, name) {
    let reg = {user: name, email: '-', password: '12345', type: 'register'}
    onOpen(client, reg)
  }

  function onOpenRegAndAuth (client, name) {
    onOpenReg(client, name)
    onOpenAuth(client, name)
  }

  // otherCheckFunc: function, that executed for another listeners
  // it params: (done, event, client, name)
  function onMessageSendJSON (done, message, client, name, json, otherCheckFunc) {
    let isAddFuncExist = (otherCheckFunc !== undefined)
    let event = JSON.parse(message)
    if (event.type === 'authorize') {
      if (event.success) {
        console.log(name + ' successfully authorized')
        client.send(JSON.stringify(json))
      } else {
        console.log(name + '  auth failed')
      }
      if (!isAddFuncExist) {
        client.close()
      }
    }
    if (isAddFuncExist) {
      otherCheckFunc(done, event, client, name)
    }
  }

  function onMessageSendJSONArray (done, message, client, name, json_arr) {
    let event = JSON.parse(message)
    if (event.type === 'authorize') {
      if (event.success) {
        console.log(name + ' successfully authorized')
        json_arr.forEach((json) => {
          client.send(JSON.stringify(json))
        })
      } else {
        console.log(name + '  auth failed')
      }
      client.close()
    }
  }

  // registration
  // req: {user, email, password, type: 'register'}
  // resp: {type: 'register', success}
  it('check register', (done) => {
    function onMessageRegister (done, message, client, name) {
      let success = {type: 'register', success: true}
      let notsuccess = {type: 'register', success: false}
      let event = JSON.parse(message)
      if (event.type === 'register') {
        if (event.success) {
          console.log('client successfully registered')
          expect(message).equal(JSON.stringify(success))
        } else {
          console.log('client register failed')
          expect(message).equal(JSON.stringify(notsuccess))
        }
        client.close()
        done()
      }
    }

    createPatternConnection(done, onMessageRegister, onOpenReg, 'client1')
  })

  // req: {user, password, type: 'authorize'}
  // resp:{success, online, type: 'authorize'}
  it('check auth', (done) => {
    function onMessageAuth (done, message, client, name) {
      let event = JSON.parse(message)
      if (event.type === 'authorize') {
        if (event.success) {
          console.log(name + ' successfully authorized')
        } else {
          console.log(name + ' auth failed')
        }
        client.close()
        done()
      }
    }
    createPatternConnection(done, onMessageAuth, onOpenAuth)
  })

  // req:  {name, fullname, admin, type: 'new_channel'}
  // resp: {name, fullname, admin, success, type: 'new_channel'}
  it('new_channel', (done) => {
    let name = 'client1'

    let new_ch = {name: 'nice_channel2',
      fullname: 'channel for nice people',
      admin: name,
      type: 'new_channel'}

    function onMessageTypeNewChannel (done, event, client, name) {
      console.log('here')
      if (event.type === 'new_channel') {
        if (event.success) {
          console.log('channel ' + event.name + ' successfully created')
          console.log('admin is ' + event.admin)
        } else {
          console.log('channel ' + event.name + ' creation failed')
        }
        client.close()
        done()
      }
    }
    // require registration
    (async () => {
      await createPatternConnection(
        done,
        (done, message, client) => { client.close() },
        onOpenReg,
        name
      )
      createPatternConnection(done, onMessageSendJSON,
        onOpenAuth, name, new_ch, onMessageTypeNewChannel)
    })()
  })

  // req:  {name, from, type: 'get_channel'}
  // resp: {channels, type : 'get_channel'}
  it('get_channel', (done) => {
    let name = 'client0'
    let chName = 'nice_channel2'
    let fullChName = 'nice channel index 2'

    let get_ch_req = {name: chName, from: name, type: 'get_channel'}

    function onMessageGetChannel (done, event, client, name) {
      if (event.type === 'get_channel') {
        if (event.channels.length === 1) {
          console.log('channel name: ' + event.channels[0].name)
          client.close()
          done()
        } else if (event.channels.length == 0) {
          console.log('there no channels with name' + chName)
          client.close()
          done()
        } else {
          console.log('bad test: channels with name ' +
            chName + ' :' + channels.toString())
        }
      }
    }

    // require user
    (async () => {
      // register
      await createPatternConnection(done,
        (done, message, client) => { client.close() },
        onOpenReg, name)

      setTimeout(() => {
        // get channel
        console.log('test get channel')
        createPatternConnection(done, onMessageSendJSON, onOpenAuth,
          name, get_ch_req, onMessageGetChannel)
      }, 1000)
    })()
  })

  // req:  {channel, from, type : 'get_channel_messages'}
  // resp: {channel, messages, from, type}
  it('get_channel_messages', (done) => {
    let name = 'client0'
    let chName = 'nice_channel3'
    let fullChName = 'nice channel index 2'

    let get_ch_m_req = {channel: chName, from: name, type: 'get_channel_messages'}

    function onMessageGetChannelMessages (done, event, client, name) {
      if (event.type === 'get_channel_messages') {
        console.log('channel messages length: ' + event.messages.length)
        client.close()
        done()
      }
      if (event.type === 'get_channel_messages_not_exist') {
        console.log('channel with name ' + event.channel + ' is not exists')
        client.close()
        done()
      }
    }

    // require user
    (async () => {
      // register
      await createPatternConnection(done,
        (done, message, client) => { client.close() },
        onOpenReg, name)

      setTimeout(() => {
        // get channel
        console.log('test get channel')
        createPatternConnection(done, onMessageSendJSON, onOpenAuth,
          name, get_ch_m_req, onMessageGetChannelMessages)
      }, 1000)
    })()
  })

  // req: {user, channel, type: 'add_user'}
  // resp: {user, channel, success, type: 'add_user'}
  it('add_user', (done) => {
    let name = 'client0'
    let chName = 'nice_channel2'
    let fullChName = 'nice channel index 2'

    let add_user = {user: name, channel: chName, type: 'add_user'}
    let cr_ch = {chName, fullChName, name, type: 'new_channel'}

    function onMessageAddUser (done, event, client, name) {
      if (event.type === 'add_user') {
        if (event.success) {
          console.log('user ' + event.user + ' successfully added to ' +
            event.channel + ' channel')
        } else {
          console.log('user ' + event.user + ' addition to ' +
            event.channel + ' failed')
        }
        client.close()
        done()
      }
    }

    // require channel, user
    (async () => {
      // register
      await createPatternConnection(done,
        (done, message, client) => { client.close() },
        onOpenReg, name
      )
      await setTimeout(() => {
        // create channel
        createPatternConnection(done, onMessageSendJSON, onOpenAuth, name, cr_ch)
      }, 500)

      setTimeout(() => {
        // add user
        console.log('test adding user')
        createPatternConnection(done, onMessageSendJSON, onOpenAuth,
          name, add_user, onMessageAddUser)
      }, 1000)
    })()
  })

  // req: {message, from, channel, time, type: 'message'}
  // resp: {message, from, channel, time, type: 'message'} (same)
  it('message', (done) => {
    let t = new Date().getTime()

    function onMessageSendMessage (done, message, client, name) {
      let new_message = {message: 'ты тоже',
        from: 'client1',
        channel: 'nice_channel1',
        time: t,
        type: 'message' }

      function onMessage (message, client) {
        let event = JSON.parse(message)
        if (event.type === 'authorize') {
          if (event.success) {
            console.log(name + ' successfully authorized')
            if (name === new_message.from) {
              // timeout for auth
              console.log('send message')
              client.send(JSON.stringify(new_message))
            }
          } else {
            console.log(name + ' auth failed')
          }
        }
        if (event.type === 'message') {
          console.log(name + ' ' + event.from)
          if (name === event.from) {
            console.log('sended message to myself')
          } else {
            expect(message).equal(JSON.stringify(new_message))
            console.log(event)
            client.close()
            done()
          }
        }
      }
      onMessage(message, client)
    }
    // test require:
    // 2 users: client0, client1
    // 1 channel with those users: nice_channel1, client0, client1
    let localName0 = 'client0'
    let localName1 = 'client1'

    // try to create new channel
    let new_ch1 = { name: 'nice_channel1',
      fullname: 'channel for nice people 1',
      admin: localName1,
      type: 'new_channel' }

    // try to add user to channel
    let add_user1 = { user: localName1, channel: 'nice_channel1', type: 'add_user' }

    let js_arr1 = []
    js_arr1.push(new_ch1)
    js_arr1.push(add_user1)

    createPatternConnection(done, onMessageSendJSONArray, onOpenRegAndAuth, localName1, js_arr1)

    // try to add user to channel
    let add_user0 = { user: localName0, channel: 'nice_channel1', type: 'add_user' }

    createPatternConnection(done, onMessageSendJSON, onOpenRegAndAuth, localName0, add_user0)

    setTimeout(() => {
      // send and receive messages
      createPatternConnection(done, onMessageSendMessage, onOpenAuth, localName1)
      createPatternConnection(done, onMessageSendMessage, onOpenAuth, localName0)
    }, 500)
  })
})
