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
    var i = 0;
    // sync loop for 5 tries to send request to ws
    (function loop () {
      if (i == 10) { return }
      if (i++ > 5) {
        console.log('sending failed')
        return
      };
      setTimeout(function () {
        console.log('try send to open')
        if (client.readyState == 1) {
          console.log('sending')
          client.send(JSON.stringify(req))
          i = 10
        }
        loop()
      }, 100)
    })()
  }

  function createPatternConnection (done, onMessage, on_Open) {
    let ws_source = 'ws://' + config.hostname + ':' + config.ws_port
    let client = new WebSocket(ws_source)

    client.onclose = (e) => { console.log('connection closed') }
    client.onerror = (e) => { console.log('connection aborted') }
    client.onopen = on_Open(client, done)

    client.on('message', (message) => {
      onMessage(done, message, client)
    })
    return client
  }

  function onOpenAuth (client, done) {
    let auth = {
      user: 'client0',
      password: '12345',
      type: 'authorize'
    }
    onOpen(client, auth)
  }

  // registration {user, email, password, type: 'register'}

  it('check register', (done) => {
    function onOpenReg (client, done) {
      let reg = {user: 'client0',
        email: '-',
        password: '12345',
        type: 'register'
      }
      onOpen(client, reg)
    }

    function onMessageRegister (done, message, client) {
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
    createPatternConnection(done, onMessageRegister, onOpenReg)
  })

  it('check auth', (done) => {
    function onMessageAuth (done, message, client) {
      function onMessage (message, client) {
        var event = JSON.parse(message)
        if (event.type == 'authorize') {
          if (event.success) {
            console.log('client0 successfully authorized')
          } else {
            console.log('client0 auth failed')
          }
          client.close()
          done()
        }
      }
      onMessage(message, client)
    }
    createPatternConnection(done, onMessageAuth, onOpenAuth)
  })

  /*
  req: {name, fullname, admin, type: 'new_channel'}
  resp: {name, fullname, admin, success, type: 'new_channel'}
  */
  it('new_channel', (done) => {
    function onMessageCreateChannel (done, message, client) {
      let new_ch = {
        name: 'nice_channel1',
        fullname: 'channel for nice people',
        admin: 'client0',
        type: 'new_channel'
      }
      function onMessage (message, client) {
        var event = JSON.parse(message)
        if (event.type == 'authorize') {
          if (event.success) {
            console.log('client0 successfully authorized')
            client.send(JSON.stringify(new_ch))
          } else {
            console.log('client0 auth failed')
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
    function onMessageAddUser (done, message, client) {
      let add_user = {
        user: 'client0',
        channel: 'nice_channel1',
        type: 'add_user'
      }
      function onMessage (message, client) {
        var event = JSON.parse(message)
        console.log(event)
        if (event.type == 'authorize') {
          if (event.success) {
            console.log('client0 successfully authorized')
            client.send(JSON.stringify(add_user))
          } else {
            console.log('client0 auth failed')
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
    createPatternConnection(done, onMessageAddUser, onOpenAuth)
  })
})
