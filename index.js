'use strict'
// --------------------------------------------------------------------------

const port      = process.env.PORT       || 8080
const fs        = require('fs')
const readline  = require('readline')
const path      = require('path')

const express   = require('express')
const app       = express()

const http      = require('http')
const server    = http.createServer(app)
const WebSocket = require('ws')
const { createWebSocketStream } = require('ws')
const wss       = new WebSocket.Server({     
    "server"    : server
})

const bsearch   = require('./bsearch.js')
const oui       = require('./oui.js')
const readLines = require('./readlines.js')

app.use(express.static(__dirname + '/public'))
app.use(express.json())

function
prepareDir(road) {
    if ( fs.existsSync(road) ) return
    let dir = path.dirname(road)
    prepareDir(dir)
    console.log('lets mkdir in', dir, road)
    fs.mkdirSync(road)
}
// -----------------------------------------------------------------------
const cacheDir = require("os").tmpdir + '/sdr/'
prepareDir(cacheDir)

let log_filename = cacheDir + 'logs.txt'

if (port === 8080 ) log_filename = './logs.txt' // local testing... HACK
// -----------------------------------------------------------------------



let Filter = require("./filter.js")


let sniffers = []
let Logs     = []               // big array with ALL the Logs, by time
let sockets  = new Set()        // All the listeners

log_load(log_process)

// from Paul
/*
{ "name": "Bluetooth", "value": { "ssid": "10:4e:89:64:ea:44", "RSSI": -85, "date": "2021-7-2 10:1:47" }, "time": 1625212948196 }

*/

app.post('/log', function (req, res) {
  res.send('Thanks')
  console.log(req.body)


  let snifferId = req.headers['x-forwarded-for'] || req.socket.remoteAddress  
  // likely should find a better Id than just the IP address (doesn't work when multiple sniffers share same IP)

  // maybe in the body have an Id for the sniffer
  // for example, could even have different Id for different sniffer module attached to same IP device
  // this way, we wouldn't rely on the transport layer
  // snifferId = req.body.id || snifferId   

//  filter_input( snifferId, req.body )

    let log       = req.body
    log.snifferId = snifferId
    log.time      = Date.now()

    log_write(log)      // save it to disk, so to resume after crash/stop...
    log_process(log)    // process it, good place for indexing.
    broadcast(log)      // no filter send to everyone listening
    
})
// ---------------------------------------------------------------------------------
app.get('/oui/', async function (req,res){
    res.send( await oui( req.query.id ) )
})
// ---------------------------------------------------------------------------------

app.get('/all/', function (req,res){
    console.log("got an ALL request")
    res.send(JSON.stringify(Logs))
})

/*
{ 
    "snifferId": "::ffff:127.0.0.1", 
    "name": "bluetoothDevices", 
    "value": [{ 
        "device": null, 
        "name": "Microsoft Bluetooth LE Enumerator", 
        "manufacturer": "Microsoft", 
        "macDevice": null, 
        "macHost": null, 
        "batteryPercent": null, 
        "type": "", 
        "connected": null 
    },{ etc.
    "time": 1624983557201
}

wifiNetworks
[
    {
      ssid: "orange",
      bssid: "78:94:b4:46:8f:6b",
      mode: "",
      channel: 6,
      frequency: 2437,
      signalLevel: -85,
      quality: 30,
      security: [
        "Open",
        "WPA2-Personal",
        "WPA3-Personal",
      ],
      wpaFlags: [
        "None",
        "CCMP",
      ],
      rsnFlags: [
      ],
    },
*/
// ---------------------------------------------------------------------------------

app.get('/query/', async function(req,res){
    let { from, to, filter } = req.query
    to   = to   || Date.now()
    from = from || to - 12 * 60 * 60 * 1000    // default of 12 hours
    let a = bsearch( Logs, from, log_time_compare ) 
    let b = bsearch( Logs,   to, log_time_compare ) 
    let results = Logs.slice(a,b)
    if (filter)
        results = Filter.filter(results, filter)
    res.send(JSON.stringify(results))
})

// from Paul
/*
{ "name": "Bluetooth", "value": { "ssid": "10:4e:89:64:ea:44", "RSSI": -85, "date": "2021-7-2 10:1:47" }, "time": 1625212948196 }

*/
// ---------------------------------------------------------------------------------

app.get('/bluetooth/', async function(req,res){
    let results = []
    for (let log of Logs){
        let { name } = log
        if ( name !== "Bluetooth" ) continue
        let { ssid, RSSI, date, time } = log
        let OUI = await oui(ssid)
        results.push({ ssid, RSSI, date, OUI, time })
    }
    res.send(JSON.stringify(results))
})
// ---------------------------------------------------------------------------------
function 
yesterday(){
    return Date.now() - (24 * 60 * 60 * 1000);
}
// ---------------------------------------------------------------------------------
app.get('/history/', function (req, res) {
    let { from, to, filter } = req.query
    to   = to   || Date.now()
    from = from || to - 12 * 60 * 60 * 1000    // default of 12 hours
    let a = bsearch( Logs, from, log_time_compare ) 
    let b = bsearch( Logs,   to, log_time_compare ) 
    let results = Logs.slice(a,b)
    if (filter)
        results = Filter.filter(results, filter)
        
    let width = 15*60*1000                          // 1/4 hour

    let answer = history(results, from, to, width)
    res.send(answer)
})
// ---------------------------------------------------------------------------------
function
history( logs, from, to, width){
    
    let nb_buckets = ( to - from ) / width
    let buckets = new Array(nb_buckets|0).fill(0)

    for ( let i in logs ){          // todo, have a 'unique' option?
        let log = logs[i]
        let index = (log.time - from ) / width
        index |= 0
        if (index < 0 || index >= nb_buckets)
            console.error("bad index in history")
        buckets[index|0]++
    }

    return buckets
}
// ---------------------------------------------------------------------------------

function
log_time_compare( log , time ){
    return log.time - time
}


// ---------------------------------------------------------------------------------
function
log_process(log){
    if (log.value) {  // some old version of log... HACK
        Object.assign(log,log.value)        // put the 'value' properties at top level of Logs
        delete log.value
    }
    Logs.push(log)      // add it to a big array
// here can add indexing, filtering, etc.. todo
}

// ---------------------------------------------------------------------------------
// for now, just save in big TMP file

let log_stream

function
log_write(log){
    log_stream = log_stream || fs.createWriteStream( log_filename, {flags:'a'})
    log_stream.write( JSON.stringify(log) +"\n" ) 
}
// ---------------------------------------------------------------------------------
async function
log_load(f){

    let line_number = 0
    await readLines(log_filename, line => {
        ++line_number
        //console.log(line_number,":", line)

        try{
            let log = JSON.parse(line) 
            f(log)
        } catch(e){
            console.error(log_filename, ':', line_number,':', e)
        }
    })
    
    // let fileStream = fs.createReadStream(log_filename)

    // fileStream.on('error', function (error) {
    //     console.error("no log file", error)
    // })

    // fileStream.on('ready', function () {
    //     const rl = readline.createInterface({
    //         input: fileStream,
    //     })
    //     rl.on('line', function(line){
    //         console.log("read", line)
    //         let log = JSON.parse(line) 
    //         f(log)
    //     })
    // })
}

// ---------------------------------------------------------------------------------

function
isArray(object){
   var type = typeof object
   return type === 'object' && Array.isArray(object)
}

function
filter_input( snifferId, data){
    if ( isArray(data) ){
        for (let d of data){
            filter_input( snifferId, d)
        }
        return
    }
    let { name, value } = data


}



// --------------------------------------------------------------------------
server.listen(port, () => {
    console.log(`SDR server listening locally on port ${port}`);
    console.log('Press Ctrl+C to quit.');    
})


wss.on( 'connection' , function (socket, request) {    
    console.log("watcher IP:", request.connection.remoteAddress)
    sockets.add(socket)    
    socket.on('close', function () {
    sockets.delete(socket)
  })
})

function
broadcast(message){
    let m = JSON.stringify(message)
    sockets.forEach(s => {
        s.send( m )
    })
}



// -----------------------------------------------------------------------
// -----------------------------------------------------------------------


