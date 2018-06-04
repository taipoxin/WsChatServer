const log = require('./logging')

// stringify function with circular reference checking
// see: https://stackoverflow.com/questions/11616630
function stringify (object) {
  let cache = []
  let js = JSON.stringify(object, function (key, value) {
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

function logList (prevMessage, list, name) {
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

module.exports = {stringify, logList}
