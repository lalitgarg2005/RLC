// @transaction.server.controller
// Author: Rijul Luman
// To store and fetch Unconfirmed Transactions

'use strict';
var async = require('async');

function decimalPlaces(num) {
  var match = (''+num).match(/(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) { return 0; }
  return Math.max(
       0,
       // Number of digits right of decimal point.
       (match[1] ? match[1].length : 0)
       // Adjust for scientific notation.
       - (match[2] ? +match[2] : 0));
}

var validateCoinValue = function (coinValue) {
    if(!coinValue) return false;
    coinValue = Number(coinValue);
    if(coinValue < 0) return false;
    if(decimalPlaces(coinValue) > 8) return false;  // Decimals upto 8 places only
    return coinValue;
 }

/**
 * Transaction Bind middleware
 */
exports.transactionByID = function(req, res, next, id) {
    if(['add'].indexOf(id)!==-1){
        next();
    }else{
        RedisHandler.getUnconfirmedTransactionById(id, function(err, transaction){
            req.transaction = transaction;
            next();
        });
    }
};

/**
 * Fetch a Transaction
 */
exports.read = function(req, res) {
    res.jsonp(req.transaction);
};

exports.create = function (req, res, next) {
    // TODO : Add transaction internal variable names to Constants
    // TODO : Use logged in user info to create transactions
    var transaction = {
        txId        : "",   // Unique Hash for this transaction
        sender      : "",
        receiver    : "",
        amount      : 0,
        fees        : 0,
        deadline    : 0,
        nonce       : 0,
        signature   : ""
    };
    if(!req.body){
        return ErrorCodeHandler.getErrorJSONData({'code':5, 'res':res});
    }
    transaction.amount = validateCoinValue(req.body.amount);
    if(!transaction.amount){
        return ErrorCodeHandler.getErrorJSONData({'code':6, 'res':res});
    }
    transaction.fees = validateCoinValue(req.body.fees);
    if(!transaction.fees){
        return ErrorCodeHandler.getErrorJSONData({'code':7, 'res':res});
    }
    if(!req.body.sender || !CommonFunctions.validatePublicKeyHexString(req.body.sender)){
        return ErrorCodeHandler.getErrorJSONData({'code':8, 'res':res});
    }
    transaction.sender = req.body.sender.toLowerCase();
    if(!req.body.receiver || !CommonFunctions.validatePublicKeyHexString(req.body.receiver)){
        return ErrorCodeHandler.getErrorJSONData({'code':9, 'res':res});
    }
    transaction.receiver = req.body.receiver.toLowerCase();
    if(transaction.sender == transaction.receiver){
        return ErrorCodeHandler.getErrorJSONData({'code':16, 'res':res});
    }
    if(!req.body.privateKey || !CommonFunctions.validatePrivateKeyHexString(req.body.privateKey)){
        return ErrorCodeHandler.getErrorJSONData({'code':10, 'res':res});
    }
    var privateKey = CommonFunctions.hexStringToBuffer(req.body.privateKey.toLowerCase());

    async.waterfall([
        function defaultDeadline(cb){
            if(!req.body.deadline){
                RedisHandler.getCurrentBlock(function(err, deadline){
                    if(err){
                        return ErrorCodeHandler.getErrorJSONData({'code':3, 'res':res});
                    }
                    else{
                        transaction.deadline = deadline + Constants.TRANSACTION_DEADLINE_OFFSET;
                    }
                    cb();
                });
            }
            else if(isNaN(parseInt(req.body.deadline))){
                return ErrorCodeHandler.getErrorJSONData({'code':11, 'res':res});
            }
            else{
                transaction.deadline = parseInt(req.body.deadline);
                cb();
            }
        },
        function generateNonce(cb){
            CommonFunctions.generateTransactionNonce(function(err, nonce){
                if(err){
                    return ErrorCodeHandler.getErrorJSONData({'code':12, 'res':res});
                }
                transaction.nonce = nonce;
                cb();
            });
        },
        function generateTransactionId(cb){
            transaction.txId = CommonFunctions.generateTransactionHash(transaction);
            cb();
        },
        function generateSignature(cb){
            transaction.signature = CommonFunctions.generateSignature(transaction.txId, privateKey);
            cb();
        }
        
        ], function(){
            addUnconfirmedTransaction(transaction);
            broadcast(transaction);
            res.status(200).jsonp(transaction);
        });

    
};

/**
 * Accept, verify and add broadcasted Unconfirmed Transaction into Redis
 */

exports.acceptBroadcastTransaction = function(transaction){
    // TODO : Re broadcast ? Will need to handle infinite loop handling (Rebroadcast only if transaction was not already present in Redis)
    console.log("Incoming BroadcastTransaction : ", transaction);
    addUnconfirmedTransaction(transaction);
};

/**
 * Validate and add transaction to Redis
 */
var addUnconfirmedTransaction = function(transaction){
    // When creating a block, we check if transaction exists in blockchain
    // TTL will be updated incase Transaction already exists in Redis
    validateAndParseTransaction(transaction, function(isValid, validatedTransaction){
        if(isValid){
            RedisHandler.addUnconfirmedTransaction(validatedTransaction, function (err, reply) {
                // Transaction Added
            }); 
        }
        else{
            console.log("Invalid Transaction could not be added");
        }
    });
};

var broadcast = function (transaction) {
    validateAndParseTransaction(transaction, function(isValid, validatedTransaction){
        if(isValid){
            BroadcastMaster.sockets.emit(Constants.SOCKET_BROADCAST_TRANSACTION, validatedTransaction);
            OutgoingSockets.forEach(function(socket){
                socket.emit(Constants.SOCKET_BROADCAST_TRANSACTION, validatedTransaction);
            });
        }
    });
};

var validateAndParseTransaction = function (transactionInput, callback) {
    if(!transactionInput || typeof(transactionInput) != "object" || Object.keys(transactionInput).length < 8){
        return callback(false, null);
    }

    var transaction = {};

    try{
        transaction = {
            txId        : transactionInput.txId.toLowerCase(),
            sender      : transactionInput.sender.toLowerCase(),
            receiver    : transactionInput.receiver.toLowerCase(),
            amount      : validateCoinValue(transactionInput.amount),
            fees        : validateCoinValue(transactionInput.fees),
            deadline    : parseInt(transactionInput.deadline),
            nonce       : parseInt(transactionInput.nonce),
            signature   : transactionInput.signature.toLowerCase()
        };
    }
    catch(e){
        return callback(false, null);
    }

    if(
            !transaction.amount
        ||  !transaction.fees
        ||  !transaction.sender 
        ||  !CommonFunctions.validatePublicKeyHexString(transaction.sender)
        ||  !transaction.receiver 
        ||  !CommonFunctions.validatePublicKeyHexString(transaction.receiver)
        ||  !transaction.nonce 
        ||  isNaN(parseInt(transaction.nonce)) 
        ||  parseInt(transaction.nonce) < Constants.MINIMUM_TRANSACTION_NONCE
        ||  transaction.sender == transaction.receiver
        ||  CommonFunctions.generateTransactionHash(transaction) != transaction.txId
        ||  !CommonFunctions.verifySignature(transaction.txId, transaction.sender, transaction.signature)
    ){
        return callback(false, null);
    }

    callback(true, transaction);

};