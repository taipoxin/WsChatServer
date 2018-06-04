const fs = require('fs')
const async = require('async')
let MAX_OPEN_FILES = 255
let __writeQueue = async.queue(function (task, callback) {
  task(callback)
}, MAX_OPEN_FILES)

let __log = function (filename, text) {
  return function (callback) {
    fs.open(filename, 'a', 0x1a4, function (error, file_handle) {
      if (!error) {
        fs.write(file_handle, text, null, 'utf8', function (err) {
          if (err) {
            console.log(filename + ' ' + err)
          }
          fs.close(file_handle, function () {
            callback()
          })
        })
      } else {
        console.log(filename + ' ' + error)
        callback()
      }
    })
  }
}

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
  __writeQueue.push(__log(file, mess))

  /*
  fs.appendFile('log.txt',
    '[' + s + ']' + ': ' + message + '\r\n', function (err) {
      if (err) throw err
    }
  )
  */
}

module.exports = log
