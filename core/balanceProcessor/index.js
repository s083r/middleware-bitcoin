const config = require('../../config'),
  mongoose = require('mongoose'),
  fetchBalanceService = require('./fetchBalanceService'),
  accountModel = require('../../models/accountModel'),
  bunyan = require('bunyan'),
  _ = require('lodash'),
  log = bunyan.createLogger({name: 'core.balanceProcessor'}),
  amqp = require('amqplib');

/**
 * @module entry point
 * @description update balances for addresses, which were specified
 * in received transactions from blockParser via amqp
 */

mongoose.Promise = Promise;
mongoose.connect(config.mongo.uri, {useMongoClient: true});

let init = async () => {
  let conn = await amqp.connect(config.rabbit.url);
  let channel = await conn.createChannel();

  try {
    await channel.assertExchange('events', 'topic', {durable: false});
    await channel.assertQueue(`app_${config.rabbit.serviceName}.balance_processor.tx`);
    await channel.bindQueue(`app_${config.rabbit.serviceName}.balance_processor.tx`, 'events', `${config.rabbit.serviceName}_transaction.*`);
  } catch (e) {
    log.error(e);
    channel = await conn.createChannel();
  }

  try {
    await channel.assertQueue(`app_${config.rabbit.serviceName}.balance_processor.block`);
    await channel.bindQueue(`app_${config.rabbit.serviceName}.balance_processor.block`, 'events', `${config.rabbit.serviceName}_block`);
  } catch (e) {
    log.error(e);
    channel = await conn.createChannel();
  }

  channel.prefetch(2);

  channel.consume(`app_${config.rabbit.serviceName}.balance_processor.block`, async data => {
    try {
      let payload = JSON.parse(data.content.toString());
      let accounts = await accountModel.find({
        $where: 'obj.balances && !(obj.balances.confirmations0 === obj.balances.confirmations3 && ' +
        'obj.balances.confirmations3 ===  obj.balances.confirmations6)',
        lastBlockCheck: {$lt: payload.block}
      });

      for (let account of accounts) {
        let balances = await fetchBalanceService(account.address);
        await accountModel.update({address: account.address}, {
          $set: _.transform({
            'balances.confirmations0': _.get(balances, 'balances.confirmations0'),
            'balances.confirmations3': _.get(balances, 'balances.confirmations3'),
            'balances.confirmations6': _.get(balances, 'balances.confirmations6')
          }, (result, val, key) => {
            if (val) {
              result[key] = val;
            }
          }, {lastBlockCheck: balances.lastBlockCheck})
        });
        channel.publish('events', `${config.rabbit.serviceName}_balance.${account.address}`, new Buffer(JSON.stringify({balances: balances.balances})));
      }

    } catch (e) {
      log.error(e);
    }

    channel.ack(data);
  });

  channel.consume(`app_${config.rabbit.serviceName}.balance_processor.tx`, async (data) => {
    try {
      let payload = JSON.parse(data.content.toString());
      let balances = await fetchBalanceService(payload.address);
      await accountModel.update({address: payload.address, lastBlockCheck: {$lt: balances.lastBlockCheck}}, {
          $set: _.transform({
            'balances.confirmations0': _.get(balances, 'balances.confirmations0'),
            'balances.confirmations3': _.get(balances, 'balances.confirmations3'),
            'balances.confirmations6': _.get(balances, 'balances.confirmations6')
          }, (result, val, key) => {
            if (val) {
              result[key] = val;
            }
          }, {lastBlockCheck: balances.lastBlockCheck})
        }
      );
      channel.publish('events', `${config.rabbit.serviceName}_balance.${payload.address}`, new Buffer(JSON.stringify({balances: balances.balances})));
      log.info(`balance updated for ${payload.address}`);
    } catch (e) {
      log.error(e);
    }

    channel.ack(data);
  });

};

module.exports = init();
