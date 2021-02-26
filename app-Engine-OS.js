const express = require('express');
const http = require('http');
const https = require('https');
const request = require('request-promise');
const cpaas = require('@avaya/cpaas'); //Avaya cloud
var enums = cpaas.enums;
var ix = cpaas.inboundXml;
const bodyParser = require('body-parser');
const cookieParse = require('cookie-parser');
const fs = require('fs');

//TO DO: Your host name 
const HOST = ""; //The Web Server hosting this application
const URL_PORT = 3000; //Port the application is running on
const PROTOCOL = "https"; //Protocol of Web Server

const LANGUAGE = {
    Gather : "en-US" , //To find all supported Avaya Cloud Gather Languages --> https://docs.avayacloud.com/aspx/inboundxml#gather
    Say : "en-us" , //To find all supported Avaya Cloud Say Languages -->https://docs.avayacloud.com/aspx/inboundxml#say
    Dialogflow : "en"
};

const VOICE = "female-premium-3"; //Avaya Cloud Voice


// Imports the Google Cloud client library.
const {SessionsClient} = require('@google-cloud/dialogflow-cx');
const uuid = require('uuid');
const { struct } = require('pb-util');


//TO DO: Fill in Dialogflow Defaults
const DIALOGFLOW_CREDENTIALS_PATH = ""; //Your Service Account Credentials JSON with Dialogflow API Admin Access
const DIALOGFLOW_PROJECT_ID = ""; //Dialogflow Project ID
const DIALOGLOW_WELCOME_EVENT = ""; //Welcome Event Name
const DIALOGFLOW_LOCATION = 'global'; //Dialogflow Regional Location
const DIALOGFLOW_AGENT_ID = ''; //Dialogflow Agent ID

//URLs that could be redirected to
const BASE_URL = PROTOCOL + "://" + HOST + ":" + URL_PORT.toString();

const APPLICATION_ENTRANCE = "/voice/";
const ONGOING_SESSION = "/voice-dialogflow/";
const SMS_APPLICATION = "/sms/";
const SMS_SESSIONS = [];




//Tells the application to use express and the bodyParser as middleware to easily parse JSON
var app = express();
app.use(bodyParser.urlencoded({
    extended : true
}));
app.use(bodyParser.json());

/*
//Begin HTTP
If you are using http vs https then use this

//Create the server and tell it to listen to the given port
var server = app.listen(URL_PORT, function () {
   var host = server.address().address;
   var port = server.address().port;
   console.log("Listening: " , URL_PORT.toString());
});

//End HTTP
*/


//Begin HTTPS
//Certificate Files for HTTPS
//TO DO: Put in key / chain files
let CHAIN_FILE =  "";
let KEY_FILE = "";

let key = fs.readFileSync(KEY_FILE).toString();
let cert = fs.readFileSync(CHAIN_FILE).toString();


let httpsOptions = {
        key: key,
        cert: cert
};

let httpsServer = https.createServer(httpsOptions, app);

httpsServer.listen(URL_PORT, function(){
    console.log("Listening: " , URL_PORT.toString());
});

// End HTTPS


app.post(APPLICATION_ENTRANCE , applicationEntrance);
app.post(ONGOING_SESSION , onGoingSession);
app.post(SMS_APPLICATION , applicationEntranceSms);






//This is where the traffic first comes in
async function applicationEntrance(req , res)
{
    let response = await interactWithBot(req.body , null , 'VOICE');

    res.type('application/xml');
    res.send(response);
}

//This is where the traffic goes to after the first bot response
async function onGoingSession(req , res)
{

    console.log("Speech: " , req.body.SpeechResult);
    console.log("Digits: " , req.body.Digits);
    console.log("SessionId: " , req.query.sessionId);

    let response = await interactWithBot(req.body , req.query.sessionId , 'VOICE');
    res.type('application/xml');
    res.send(response);
}

//This is where the traffic first comes in
async function applicationEntranceSms(req , res)
{
    let response = await interactWithBot(req.body , getSmsSessionId(req.body.From) , 'SMS');

    res.type('application/xml');
    res.send(response);
}

//Gets the SMS Session ID
// Creates new one if it doesnt exist
function getSmsSessionId(from)
{
    if(! SMS_SESSIONS[from]) {
        SMS_SESSIONS[from] = createNewSessionId();
    }

    return SMS_SESSIONS[from];

}




/*
    Interacts with the dialogflow bot.  It will either create a new session or use an existing
    @Parameters:
        body : HTTP Request body sent in from Avaya Cloud [https://docs.avayacloud.com/aspx/inboundxml#request] <-- Request Body Defined Here
        session_id : Dialogflow Session ID (Set to null if you want a new session)
        interaction_type : either 'VOICE' or 'SMS'
    @Returns: XML Definition

*/
async function interactWithBot(body , session_id , interaction_type)
{

            let queryInfoObject = null;
            let avayaCloudInfoOutputContext = false;

            if(! session_id) { //Use event
                  session_id = createNewSessionId();
                  queryInfoObject = createQueryInputObject(
                      {
                          type : "event" ,
                          body : {
                            event : DIALOGLOW_WELCOME_EVENT
                          }
                      } ,
                      LANGUAGE.Dialogflow
                  );
            } else {

                if(body.Digits && body.Digits != "") { //Use DTMF input
                    queryInfoObject = createQueryInputObject(
                        {
                          type : "dtmf" ,
                          body : {
                            dtmf : {
                                digits : body.Digits
                            }
                          }
                      } ,
                      LANGUAGE.Dialogflow
                    );
                } else { //Use Speech Input

                    let textToUse = body.SpeechResult;
                    if(interaction_type == "SMS") {
                        textToUse = body.Body;
                    }

                    queryInfoObject = createQueryInputObject(
                        {
                          type : "text" ,
                          body : {
                            text : textToUse
                          }
                      } ,
                      LANGUAGE.Dialogflow
                    );
                }

            }

            let resp = await detect_intent_cx(queryInfoObject , session_id , body , interaction_type);

            let xmlDefinition = null;
            if(interaction_type == "VOICE") {
                xmlDefinition = await postDetectionVoiceCX(resp.text , resp.parameters , session_id , body);
            } else {
                xmlDefinition = await postDetectionSmsCX(resp.text , resp.parameters , session_id , body);
            }

            let response = await buildCPaaSResponse(xmlDefinition);


            return response;

}

/*
    @param: json = {
        type : "dtmf" //type is either "dtmf" , "text" , "event"
        body : {
          event : "eventName" ,
          text : "text" ,
          dtmf : {
              "digits" : "1" ,
              "finish_digit" : "*"
          }
        }
    }

    @param: languageCode = 'en' //Dialogflow language code
*/
function createQueryInputObject(json , languageCode)
{
    let queryInput = {};

    switch(json.type)
    {
        case "dtmf":
          queryInput.dtmf = {};

          console.log("DTMF Case: " , json);

          if(json.body.dtmf && json.body.dtmf.digits) {
              queryInput.dtmf.digits = json.body.dtmf.digits;
          }

          if(json.body.dtmf.finish_digit) {
              queryInput.dtmf.finish_digit = json.body.dtmf.finish_digit;
          }
        break;
        case "text":
          queryInput.text = {};

          if(json.body.text) {
              queryInput.text.text = json.body.text;
          }
        break;
        case "event":
          queryInput.event = {};

          if(json.body.event) {
              queryInput.event.event = json.body.event;
          }
        break;
    }

    queryInput.languageCode = languageCode;

    console.log("Query Object: " , queryInput);
    return queryInput;


}

/**
 * Example for regional endpoint:
 *   const location = 'us-central1'
 *   const client = new SessionsClient({apiEndpoint: 'us-central1-dialogflow.googleapis.com'})
 */

async function detect_intent_cx(queryInputObject , session_id , body , interaction_type) {

    const projectId = DIALOGFLOW_PROJECT_ID;
    const keyFilename = DIALOGFLOW_CREDENTIALS_PATH;
    const client = new SessionsClient({projectId, keyFilename});

    const sessionId = session_id;
    const sessionPath = client.projectLocationAgentSessionPath(
      DIALOGFLOW_PROJECT_ID,
      DIALOGFLOW_LOCATION,
      DIALOGFLOW_AGENT_ID,
      sessionId
    );
    //console.info(sessionPath);

    //console.log("ProjectId: " , DIALOGFLOW_PROJECT_ID);
    //console.log("keyFilename: " , DIALOGFLOW_CREDENTIALS_PATH);

    let queryParams = {
        calling_party : body.From ,
        called_party : body.To ,
        interaction_type : interaction_type
    };

    if(interaction_type == "SMS") {
        queryParams.sms_sid = body.SmsSid;
    } else {
        queryParams.call_sid = body.CallSid;
    }

    const queryParameters = struct.encode(queryParams);

    console.log("Pre Query Parameters: " , queryParameters);

    const request = {
      session: sessionPath,
      queryInput: queryInputObject,
      queryParams : {
         parameters : queryParameters
      }
    };


    const [response] = await client.detectIntent(request);

    //console.log("Query Result: " , response.queryResult);

    let msgText = [];
    for (const message of response.queryResult.responseMessages) {
      if (message.text) {
        console.log(`Agent Response: ${message.text.text}`);
        msgText.push(message.text.text);
      }
    }

    const methodResponse = {
        text : msgText.join(' ') ,
        parameters : response.queryResult.parameters
    };

    console.log("Method Response: " , methodResponse)

    return methodResponse;

}

/*
    Calls the detect_intent_texts() method
    @Parameters:
        text : Dialogflow query response text
        parameters : Dialogflow session parameters
        sessionId : Dialogflow Session ID
        body : HTTP Request body sent in from Avaya Cloud [https://docs.avayacloud.com/aspx/inboundxml#request] <-- Request Body Defined Here
    @Returns: An @avaya/cpaas  response object
*/
async function postDetectionVoiceCX(text , parameters , sessionId , body)
{

    //Getting extra inboundXML Elements based on the parameters
    let extraStuff = analyzeSessionParametersCX(parameters , body);

    //Getting the speech hints based on the parameters
    let speechHints = getSpeechHintsCX(parameters);

    //Getting the dtmf info based on the parameters
    var dtmfInfo = getDTMFinfoCX(parameters);


    return AvayaCloudResponseVoiceCX(text , extraStuff , sessionId , speechHints , dtmfInfo);
}

/*
    Calls the detect_intent_texts() method
    @Parameters:
        text : Dialogflow query response text
        parameters : Dialogflow session parameters
        sessionId : Dialogflow Session ID
        body : HTTP Request body sent in from Avaya Cloud [https://docs.avayacloud.com/aspx/inboundxml#request] <-- Request Body Defined Here
    @Returns: An @avaya/cpaas  response object
*/
async function postDetectionSmsCX(text , parameters , sessionId , body)
{

    //Getting extra inboundXML Elements based on the parameters
    //let extraStuff = analyzeSessionParametersSmsCX(parameters , body);

    return AvayaCloudResponseSmsCX(text , body.To , body.From);
}





/*
    Looks at the dialogflow output contexts to figure out if we should forward the call or hangup
    More could be added to this incase you want to give Avaya Cloud further inboundXML instructions
    @Parameters:
        contexts : Dialogflow outputContexts
    @Returns: An array of @avaya/cpaas  objects
*/
function analyzeSessionParametersCX(parameters , body)
{
    let fields = parameters.fields;
    if(! fields) {
        return [];
    }


    let extraStuff = [];


    if(fields.avaya_cloud_transfer && fields.avaya_cloud_transfer.boolValue) { //Transfer

          let transferTo = fields.avaya_cloud_transfer_to.stringValue;
          let callerId = null;
          if(fields.avaya_cloud_transfer_caller_id && fields.avaya_cloud_transfer_caller_id.stringValue) {

              callerId = fields.avaya_cloud_transfer_caller_id.stringValue;
              switch(callerId)
              {
                  case "FROM":
                    callerId = body.From;
                  break;
                  case "TO":
                    callerId = body.To;
                  break;
                  case "":
                    callerId = null;
                  break;
              }

              let forward = null;
              let dialParameters = {};
              if(fields.avaya_cloud_sip_transfer && fields.avaya_cloud_sip_transfer.boolValue) { //must be SIP

                  let sip_parameters = {};
                  sip_parameters.sipAddress = transferTo;

                  //Get SIP username
                  if(fields.avaya_cloud_sip_username && fields.avaya_cloud_sip_username.stringValue) {
                      sip_parameters.username = fields.avaya_cloud_sip_username.stringValue;
                  }

                  //Get SIP password
                  if(fields.avaya_cloud_sip_password && fields.avaya_cloud_sip_password.stringValue) {
                      sip_parameters.password = fields.avaya_cloud_sip_password.stringValue;
                  }

                  //Direct Media  / SIP Refer transfer
                  if(fields.avaya_cloud_sip_direct_media && fields.avaya_cloud_sip_direct_media.boolValue) {
                      sip_parameters.directMedia = fields.avaya_cloud_sip_direct_media.boolValue;
                  }


                  let sip_number = ix.sip(sip_parameters);
                  dialParameters.content = sip_number;

              } else if(transferTo) { //PSTN

                  var number = ix.number({number : transferTo});
                  dialParameters.content = number;


              }


              if(callerId) {
                  dialParameters.callerId = callerId;
              }

              forward = ix.dial(dialParameters);
              extraStuff.push(forward);


          }

    }

    if(fields.avaya_cloud_end_conversation && fields.avaya_cloud_end_conversation.boolValue) { //Hang Up

        let hangup = ix.hangup();
        extraStuff.push(hangup);

    }


    return extraStuff;
}

/*
    Looks at the dialogflow output contexts to figure out if there are speech hints
    @Parameters:
        parameters : Dialogflow session parameters
    @Returns: A string representing the hints to use for speech rec
*/
function getSpeechHintsCX(parameters)
{
    console.log("getSpeechHints");

    let fields = parameters.fields;
    if(! fields) {
        return "";
    }

    var ALPHA_NUMERIC_HINTS = "0,1,2,3,4,5,6,7,8,9,A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,W,X,Y,Z";
    var DIGIT_HINTS = "0,1,2,3,4,5,6,7,9";
    var LETTER_HINTS = "A,B,C,D,E,F,G,H,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,W,X,Y,Z";
    var COMMON_YES = "yes,yeah,yup,why not,okay i will,yes that's alright,yes i do, exactly,of course,yep,that's okay,ok,okay,sure,for sure,sg,yes that's ok,i agree,yes you can do it, i don't mind,that one works,that works,sure why not,perfect,i think so, yep that's right,yes i agree,sounds correct,sounds good,that's correct,go ahead,do it,it's fine,alright,yes please,alright why not,right,looks perfect,yes i can,confirm,absolutely";
    var COMMON_NO = "thanks but no,no way,no,no don't,na,nah,no it isn't,don't,nah i'm good,no i cannot, I can't,nothing,no that's ok, nope, no not really,nope not really,thanks but not this time,I don't think so,thanks but not this time,no maybe next time,not this time,i disagree,no we are good,don't do it,no that be all,not right now, no thanks, no that's ok,I don't want that,definitely not,nothing else,not,not at all,no never,no way no,not really,not today, not interested,no that's fine thank you,i'm not";
    var COMMON_YES_AND_NO = COMMON_YES + "," + COMMON_NO;
    var total_hints = "";

    if(fields.avaya_cloud_speech_hints && fields.avaya_cloud_speech_hints.boolValue) { //Get Speech Hints

          if(fields.avaya_cloud_custom_speech_hints && fields.avaya_cloud_custom_speech_hints.stringValue) { //Custom speech hints
              total_hints += fields.avaya_cloud_custom_speech_hints.stringValue;
          }

          if(fields.avaya_cloud_speech_hints_alphanumeric && fields.avaya_cloud_speech_hints_alphanumeric.boolValue) { //Alphanumeric speech hints
              var replace = DIGIT_HINTS;
              var re = new RegExp(replace,"g");
              total_hints.replace(re , '');

              replace = LETTER_HINTS;
              re = new RegExp(replace,"g");
              total_hints.replace(re , '');

              total_hints += ALPHA_NUMERIC_HINTS;
          }

          if(fields.avaya_cloud_speech_hints_digits && fields.avaya_cloud_speech_hints_digits.boolValue) { //Digit hints

              if(total_hints.indexOf(DIGIT_HINTS) == -1) {
                  total_hints += DIGIT_HINTS;
              }

          }

          if(fields.avaya_cloud_speech_hints_letters && fields.avaya_cloud_speech_hints_letters.boolValue) { //Digit hints

              if(total_hints.indexOf(LETTER_HINTS) == -1) {
                  total_hints += LETTER_HINTS;
              }

          }

          if(fields.avaya_cloud_speech_hints_common_yes_and_no && fields.avaya_cloud_speech_hints_common_yes_and_no.boolValue) { //Yes and no hints

              if(total_hints.indexOf(COMMON_YES_AND_NO) == -1) {
                  total_hints += COMMON_YES_AND_NO;
              }

          }
    }




    return total_hints;
}

/*
    Looks at the dialogflow parameters to figure out if there is dtmf input
    @Parameters:
        parameters : Dialogflow session parameters
    @Returns: A JSON reperesenting the DTMF info
*/
function getDTMFinfoCX(parameters)
{
    console.log("getDTMFinfo");


    var dtmfInfo = {
        isDTMF : false ,
        stopDigit : "" ,
        totalDigits : null ,
        timeout : 5 ,
        noDTMF : false
    };

    if(! parameters || ! parameters.fields) {
        return dtmfInfo;
    }

    let fields = parameters.fields;


    if(fields.avaya_cloud_dtmf && fields.avaya_cloud_dtmf.boolValue) { //Enable DTMF
        dtmfInfo.isDTMF = true;

        if(fields.avaya_cloud_dtmf_stop_digit && fields.avaya_cloud_dtmf_stop_digit.stringValue) {
            let stop = fields.avaya_cloud_dtmf_stop_digit.stringValue;

            if(stop == "star") {
                stop = "*";
            }

            if(stop == "pound") {
                stop = "#";
            }

            dtmfInfo.stopDigit = stop;
        }

        if(fields.avaya_cloud_dtmf_num_digits && fields.avaya_cloud_dtmf_num_digits.numberValue) { //Look for number of digits

            let num_digits = fields.avaya_cloud_dtmf_num_digits.numberValue; //Number of digits to collect

            if(num_digits && num_digits.toString() == "NaN") {
                num_digits = 1;
            }

            dtmfInfo.totalDigits = num_digits;
        }

        if(fields.avaya_cloud_dtmf_timeout && fields.avaya_cloud_dtmf_timeout.numberValue) { //Look for timeout

            let timeout = fields.avaya_cloud_dtmf_timeout.numberValue; //Timeout

            if(timeout && timeout.toString() == "NaN") {
                timeout = 10;
            }

            dtmfInfo.timeout = timeout;
        }
    }

    if(fields.avaya_cloud_dtmf && ! fields.avaya_cloud_dtmf.boolValue) {
        dtmfInfo.noDTMF = true;
        dtmfInfo.isDTMF = false;
    }

    return dtmfInfo;
}

/*
    Inspects all of the @avaya/cpaas objects and concatenates them in the right
    order to generate an @avaya/cpaas Response object
    @Parameters:
        msg : What to say back to the caller
        extraStuff : Additional @avaya/cpaas objects resulting from dialogflow output contexts
        sessionId : Dialogflow session id
        speechHints : Hints to give to the TTS engine
        dtmfInfo : dtmfInfo resulting from the outputContexts
    @Returns: An @avaya/cpaas  response object
*/
function AvayaCloudResponseVoiceCX(msg , extraStuff , sessionId , speechHints , dtmfInfo)
{


    var hangup = false;
    var forward = false;
    if(extraStuff != null) {
        for(var i = 0; i < extraStuff.length; i++)
        {
            if(extraStuff[i].Hangup != null) {
                hangup = true;
            }

            if(extraStuff[i].Dial != null) {
                forward = true;
            }
        } //Figure out if this is the end of the call
    }



    if(hangup == true || forward == true)
    {
        var xml_content = [];
        if(msg && (msg.length != 0 || msg != "" || msg.replace(/\s/g, '') != "")) { // handles a blank message
            var say =  ix.say({
                      language: LANGUAGE.Say,
                      text: msg ,
                      voice : VOICE
            });


            xml_content.push(say);
        }


        if(extraStuff != null && extraStuff.length > 0) {
            if(xml_content.length <= 0) {
                xml_content = extraStuff;
            } else {
                xml_content = xml_content.concat(extraStuff);
            }
        }
        var xmlDefinition = ix.response({content: xml_content});
    }
    else
    {

          var says = [];


          var say1 = ix.say({
              language: LANGUAGE.Say,
              text: msg ,
              voice : VOICE
          });
          says.push(say1);


          var actionUrl = BASE_URL + ONGOING_SESSION + "?sessionId=" + sessionId;
          var timeout = 10;

          var gather = null;

          if(dtmfInfo.isDTMF) { //Create a DTMF collector
              gather = createDTMFGather(actionUrl , "POST" , dtmfInfo.timeout , dtmfInfo.stopDigit , dtmfInfo.totalDigits , LANGUAGE.Gather , speechHints , says);
          } else {
              gather = createSpeechGather(actionUrl , "POST" , timeout ,  LANGUAGE.Gather , speechHints , says);
          }

          var xml_content = [];
          xml_content.push(gather);

          if(extraStuff != null && extraStuff.length > 0) {
              xml_content = xml_content.concat(extraStuff);
          }
          var xmlDefinition = ix.response({content: xml_content});


    }

    return xmlDefinition;
}

function AvayaCloudResponseSmsCX(msg , botNumber , customerNumber)
{

      let sms = ix.sms({
          to : customerNumber ,
          from : botNumber ,
          //text : msg + "\u200D"
          text : msg
      });

      let xml_content = [];
      xml_content.push(sms);

      let xmlDefinition = ix.response({content: xml_content});

      return xmlDefinition;
}


function createDTMFGather(actionUrl , method , timeout , stopDigit , numDigits , language , speechHints , content)
{
      var gather = null;


      if(! timeout) {
          timeout = 5;
      }


      let gatherParameters = {
        action : actionUrl ,
        method : method ,
        input : "speech dtmf" ,
        timeout : timeout ,
        language : language ,
      //  hints : speechHints ,
        content : content
      };

      if(numDigits) {
          gatherParameters.numDigits = numDigits;
      }

      if(stopDigit || stopDigit == "") {
          gatherParameters.finishOnKey = stopDigit;
      }

      gather = ix.gather(gatherParameters);




      return gather;
}

function createSpeechGather(actionUrl , method , timeout , language , speechHints , content)
{
      var gather = ix.gather({
          action : actionUrl ,
          method : method ,
          input : "speech" ,
          timeout : timeout ,
          language : language ,
          hints : speechHints ,
          content : content
      });

      return gather;
}

/*
    Builds the CPaaS XML Response based off of the XML object definition
    @Parameters:
        xmlDefinition : XML object
    @Returns: XML Definition for server response

*/
async function buildCPaaSResponse(xmlDefinition)
{
      var result = await ix.build(xmlDefinition).then(function(xml){
          return xml;
      }).catch(function(err){

      });

      return result;
}

function createNewSessionId()
{
    return Math.random().toString(36).substring(7);
}
