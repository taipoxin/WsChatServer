const config = require('../config')

var mocha = require('mocha')
var chai = require('chai')
var expect = chai.expect

var WebSocket = require('ws')

var client0,
    client1,
    client2,
    client3,
    client4,
    client5,
    client6,
    client7,
    client8,
    client9

const fs = require('fs');

fs.appendFile('testlog.txt', 'another test\n', function (err) {
  if (err) throw err
})

let ws_source = 'ws://' + config.hostname + ':' + config.ws_port


describe('ws tests', () => {

  before(() => {
    /*
    let ws_source = 'ws://' + config.hostname + ':' + config.ws_port
    client0 = new WebSocket(ws_source)
    
    
    client1 = new WebSocket(ws_source)
    client2 = new WebSocket(ws_source)
    client3 = new WebSocket(ws_source)
    client4 = new WebSocket(ws_source)
    client5 = new WebSocket(ws_source)
    client6 = new WebSocket(ws_source)
    client7 = new WebSocket(ws_source)
    client8 = new WebSocket(ws_source)
    client9 = new WebSocket(ws_source)

*/
  })

  // registration {user, email, password, type: 'register'}
  it('check register', (done) => {
    let success = {
      type: 'register',
      success: true
    }
    let notsuccess = {
      type: 'register',
      success: false
    }

    let reg = {
      user: 'client0',
      email: '-',
      password: '12345',
      type: 'register'
    }

    let ws_source = 'ws://' + config.hostname + ':' + config.ws_port
    client0 = new WebSocket(ws_source)


    client0.onerror = function(evt) {
          console.log('hui')
    }

    client0.onopen = function (evt) {
      console.log('sending')
      client0.send(JSON.stringify(reg))
    }

    client0.on('message', function (message)  {
      console.log('opened')
      var event = JSON.parse(message)

      if (event.type == 'register') {
        if (event.success) {
          console.log('client0 successfully registered')
          expect(message).equal(JSON.stringify(success))
          client0.close()
          done()
        }
        else {
          console.log('client0 register failed')
          expect(message).equal(JSON.stringify(notsuccess))
          client0.close()
          done()
        } 
      } 
    })
  })

  it('check auth', (done) => {
      
    let auth = {
      user: 'client0',
      password: '12345',
      type: 'authorize'
    }

    let ws_source = 'ws://' + config.hostname + ':' + config.ws_port
    client0 = new WebSocket(ws_source)

    client0.onopen = function (evt) {
      console.log('sending')
      client0.send(JSON.stringify(auth))
    }

    client0.onerror = function(evt) {
          console.log('hui')
    }

    client0.on('message', function (message)  {
      console.log('opened')
      var event = JSON.parse(message)

      if (event.type == 'authorize') {
        if (event.success) {
          console.log('client0 successfully authorized')
        }
        else {
          console.log('client0 auth failed')
        } 
        client0.close()
        done()
      } 
    })
  })
})
