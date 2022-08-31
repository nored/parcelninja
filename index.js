// init project
var express = require("express");
var low = require("lowdb");
var FileSync = require("lowdb/adapters/FileSync");
var path = require("path");
const axios = require('axios');
const rateLimit = require('axios-rate-limit');
const cron = require("node-cron")
require('dotenv').config()


// Data is stored in the file `database.json` in the folder `db`.
// Note that if you leave your app public, this database file will be copied if
// someone forks your app. So don't use it to store sensitive information.
var adapter = new FileSync("database.json");
var db = low(adapter);
var app = express();
var bodyParser = require("body-parser");
const srcPath = __dirname;
const port = process.env.PORT || 3000;
const url = process.env.BOT_URL
const dhlUrl = process.env.DHL_URL
const dhlKey = process.env.DHL_KEY
const apiToken = process.env.TELEGRAM_KEY;
const http = rateLimit(axios.create(), { maxRequests: 1, perMilliseconds: 1000, maxRPS: 1 })

// Using `public` for static files: http://expressjs.com/en/starter/static-files.html
app.use(express.static(path.join(srcPath, "public")));
// Configurations
app.use(bodyParser.json());
// Use bodyParser to parse application/x-www-form-urlencoded form data
var urlencodedParser = bodyParser.urlencoded({ extended: false });



//console.log(process.env)


// Endpoints
// Endpoints
app.post('/', (req, res) => {
    //console.log(req.body);
    if (req.body.message) {
        const chatId = req.body.message.chat.id;
        const sentMessage = req.body.message.text;     // Regex for hello
        if (sentMessage.match(/\/track/gi)) {
            let trackingNumber = sentMessage.split(' ')[1];;
            var numbers = db.get("numbers").value();
            if(!numbers){
                numbers = [];
            }
            const number = numbers.find(({ id }) => id === trackingNumber);
            if (number) {
                trackingNumber = ("Already tracked");
            } else {
                db.get("numbers").push({"id": trackingNumber, "status": ""}).write();
            }
            axios.post(`${url}${apiToken}/sendMessage`,
                {
                    chat_id: chatId,
                    text: `Your TrackingNumber is: ${trackingNumber} 👋`
                })
                .then((response) => { 
                    res.status(200).send(response);
                }).catch((error) => {
                    res.send(error);
                });
        } else if (sentMessage.match(/\/status/gi)){
            getAll();
            res.status(200).send("Status sent");
        }else if (sentMessage.match(/\/help/gi)) {
            axios.post(`${url}${apiToken}/sendMessage`,
                {
                    chat_id: chatId,
                    text: `/track <trackingNumber> - Track your parcel\n/status - Get the status of all tracked parcels\n/help - Show this help message`
                })
                .then((response) => { 
                    res.status(200).send(response);
                }).catch((error) => {
                    res.send(error);
                });
        
        }else {
            // if no hello present, just respond with 200 
            res.status(200).send({});
        }
    } else {
        // if no hello present, just respond with 200 
        res.status(200).send({});
    }
});

async function track(num) {
    let status = "";
    const trackingId = num.id;
    const oldStatus = num.status;

    try{
        await http.get(dhlUrl, {
            params: {
                'trackingNumber': trackingId
            },
            headers: {
                'Accept': 'application/json',
                'DHL-API-Key': dhlKey
            }
        }).then(function (response) {
            const service = response.data.shipments[0].service;
            const originCountryCode = response.data.shipments[0].origin.address.countryCode;
            const destinationCountryCode = response.data.shipments[0].destination.address.countryCode;
            return {service, originCountryCode, destinationCountryCode};
        }).then(async function (response) {
            const res = await http.get(dhlUrl, {
                params: {
                    'trackingNumber': trackingId,
                    'service': response.service,
                    'originCountryCode': response.originCountryCode,
                    'requesterCountryCode': response.destinationCountryCode
                },
                headers: {
                    'DHL-API-Key': dhlKey
                }
            }) 
            return res;
        }).then(async function (res) {
            if(res.data.shipments[0].status){
                status = res.data.shipments[0].status.statusCode;
                
                if(status === 'The shipment has been successfully delivered'){
                    // Delete from db
                    await deleteOne(trackingId);
                } else {
                    // Update status in db
                    await updateStatus(trackingId, status);
                }
            } else {
                status = "Parcel not handed over";
                await updateStatus(trackingId, status);
            }
            if(status != oldStatus){
                console.log("old: " + oldStatus + " new: " + status);
                sendTelegramMessage(trackingId, status, oldStatus);
            }
        })
    } catch (error) {
        console.log(error);
        status = "Parcel not found";
    }
    //console.log(status);
}

async function deleteOne(trackingId){
    const numbers = await db.get("numbers").value();
    let newNumbers = [];
    newNumbers = numbers.filter( obj => obj.id !== trackingId);
    db.get("numbers").remove().write();
    newNumbers.forEach(element => {
        db.get("numbers").push(element).write();
    });
}

async function updateStatus(trackingId, status){
    const numbers = await db.get("numbers").value();
    let newNumbers = [];
    newNumbers = numbers.filter( obj => obj.id !== trackingId);
    newNumbers.push({"id": trackingId, "status": status || "Parcel not handed over"});
    db.get("numbers").remove().write();
    //console.log(newNumbers);
    newNumbers.forEach(element => {
        db.get("numbers").push(element).write();
    });
}

function sendTelegramMessage(id, message, old = null) {
    let text = "";
    if(old){
    text = `📯 The status of your parcel (${id}) has changed from: ${old} -> ${message} 📯`;
    }
    else{
    text = `The status of your parcel (${id}) is: ${message} 👋`;

    }

    axios.post(`${url}${apiToken}/sendMessage`,
        {
            chat_id: process.env.CHAT_ID,
            text: text
        })
        .then((response) => { 
            //console.log(response);
        }).catch((error) => {
            console.log(error);
        });
}

function getAll(){
    const numbers = db.get("numbers").value();

    numbers.forEach(element => {
        sendTelegramMessage(element.id, element.status);
    });
}

cron.schedule("*/30 * * * *", function() {
    console.log("30 minute less lifetime");
    var numbers = db.get("numbers");
    if(numbers != undefined){
        numbers.value().forEach(number => {
            track(number);
        });
    }
});


// Listen on port 8080
var listener = app.listen(port, function() {
  console.log("Running; Open at http://127.0.0.1:" + listener.address().port);
});