const config = require('../config')
var mocha = require('mocha')
var chai = require('chai')
var expect = chai.expect
var WebSocket = require('ws')

function logTest () {
  const fs = require('fs')
  let s = new Date().toUTCString()
  fs.appendFile('testlog.txt',
    '[' + s + ']' + ':  another test\n', function (err) {
      if (err) throw err
    })
}
logTest()

describe('ws tests', () => {
  

  before(() => {
  })

  function onOpen (client, req) {
    let timeout_t = 10
    let times = 100
    var i = 0;
    // sync loop for 5 tries to send request to ws
    (function loop () {
      if (i == times + 10) { return }
      if (i++ > times) {
        console.log('sending failed')
        return
      };
      setTimeout(function () {
        console.log('try send to open')
        if (client.readyState == 1) {
          console.log('sending')
          client.send(JSON.stringify(req))
          i = times + 10
        }
        loop()
      }, timeout_t)
    })()
  }

  function createPatternConnection (done, onMessage, on_Open, clientName) {
    let name = clientName
    if (clientName == undefined) {
      name = 'client0'
    }

    let ws_source = 'ws://' + config.hostname + ':' + config.ws_port
    let client = new WebSocket(ws_source)

    client.onclose = (e) => { console.log('connection closed') }
    client.onerror = (e) => { console.log('connection aborted') }
    client.onopen = on_Open(client, done, name)

    client.on('message', (message) => {
      onMessage(done, message, client, name)
    })
    return client
  }

  function onOpenAuth (client, done, name) {
    let auth = {
      user: name,
      password: '12345',
      type: 'authorize'
    }
    onOpen(client, auth)
  }


  // registration {user, email, password, type: 'register'}
  it('check register', (done) => {
    function onOpenReg (client, done, name) {
      let reg = {user: name,
        email: '-',
        password: '12345',
        type: 'register'
      }
      onOpen(client, reg)
    }

    function onMessageRegister (done, message, client, name) {
      let success = {type: 'register', success: true}
      let notsuccess = {type: 'register', success: false}

      function onMessage (message, client, success, notsuccess) {
        var event = JSON.parse(message)

        if (event.type == 'register') {
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
      onMessage(message, client, success, notsuccess)
    }
    createPatternConnection(done, onMessageRegister, onOpenReg, 'client1')
  })

  it('check auth', (done) => {
    function onMessageAuth (done, message, client, name) {
      function onMessage (message, client) {
        var event = JSON.parse(message)
        if (event.type == 'authorize') {
          if (event.success) {
            console.log(name + ' successfully authorized')
          } else {
            console.log(name + ' auth failed')
          }
          client.close()
          done()
        }
      }
      onMessage(message, client)
    }
    createPatternConnection(done, onMessageAuth, onOpenAuth)
  })

  
  // req: {name, fullname, admin, type: 'new_channel'}
  // resp: {name, fullname, admin, success, type: 'new_channel'}
  it('new_channel', (done) => {
    function onMessageCreateChannel (done, message, client, name) {
      let new_ch = {
        name: 'nice_channel1',
        fullname: 'channel for nice people',
        admin: name,
        type: 'new_channel'
      }
      function onMessage (message, client) {
        var event = JSON.parse(message)
        if (event.type == 'authorize') {
          if (event.success) {
            console.log(name + ' successfully authorized')
            client.send(JSON.stringify(new_ch))
          } else {
            console.log(name + '  auth failed')
          }
        }
        if (event.type == 'new_channel') {
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
      onMessage(message, client)
    }
    createPatternConnection(done, onMessageCreateChannel, onOpenAuth)
  })

  // req: {user, channel, type: 'add_user'}
  // resp: {user, channel, success, type: 'add_user'}
  it('add_user', (done) => {
    function onMessageAddUser (done, message, client, name) {
      let add_user = {
        user: name,
        channel: 'nice_channel1',
        type: 'add_user'
      }
      function onMessage (message, client) {
        var event = JSON.parse(message)
        if (event.type == 'authorize') {
          if (event.success) {
            console.log(name + ' successfully authorized')
            client.send(JSON.stringify(add_user))
          } else {
            console.log(name + ' auth failed')
          }
        }
        if (event.type == 'add_user') {
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
      onMessage(message, client)
    }
    createPatternConnection(done, onMessageAddUser, onOpenAuth, 'client1')
  })


  // req: {message, from, channel, time, type: 'message'}
  // resp: {message, from, channel, time, type: 'message'}
  it('message', (done) => {
    let t = new Date().getTime()
    function onMessageSendMessage (done, message, client, name) {
      let new_message = {
        message: 'ты пидор',
        from: 'client0',
        channel: 'nice_channel1',
        time: t,
        type: 'message'
      }
      function onMessage (message, client) {
        var event = JSON.parse(message)
        if (event.type == 'authorize') {
          if (event.success) {
            console.log(name + ' successfully authorized')
            if (name == 'client0') {
              console.log('send message')
              client.send(JSON.stringify(new_message))
            }
          } else {
            console.log(name + ' auth failed')
          }
        }
        if (event.type == 'message') {
          if (name == event.from) {
            console.log('sended message to myself')
          }
          else {
            expect(message).equal(JSON.stringify(new_message))
            console.log(event)
            client.close()
            done()
          }
        }
      }
      onMessage(message, client)
    }
    createPatternConnection(done, onMessageSendMessage, onOpenAuth, 'client1')
    createPatternConnection(done, onMessageSendMessage, onOpenAuth, 'client0')
  })

})
