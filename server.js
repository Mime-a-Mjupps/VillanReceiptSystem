const Zettle = require("./zettle");
const Printer = require("./printer");
require("dotenv").config(); // Load vars from env file.
const logger = require("pino")({ level: process.env.LOG_LEVEL || "info" });
// Database stuff
const Keyv = require("keyv");
const keyv = new Keyv("sqlite://database.sqlite");
keyv.on("error", (err) => logger.error("Connection Error", err));
// Setup printers and their IP's.
const registerOne = new Printer(process.env.REGISTER_ONE_PRINTER_IP, "STAR"); // Register one, "Kassa 1".
const registerTwo = new Printer(process.env.REGISTER_TWO_PRINTER_IP, "STAR"); // Register two, "Kassa 2".
const kitchen = new Printer(process.env.KITCHEN_PRINTER_IP, "EPSON"); // Printer down in the kitchen, epson printer.
// Lets start the Zettle API.
let api = new Zettle({
  clientId: process.env.CLIENT_ID,
  assertionToken: process.env.ASSERT_TOKEN,
});
// Helper functions
/**
 * Generates a new order ID.
 * @returns {String} An order "ID"
 */
async function newOrderId() {
  curOrderId = await keyv.get("currentOrderId");
  if (curOrderId == null) {
    //Make sure we always can start an id.
    await keyv.set("currentOrderId", 1);
  }
  curOrderId = (curOrderId + 1) % 200;
  await keyv.set("currentOrderId", curOrderId);
  return ("000000000" + curOrderId).substr(-3);
}
/**
 * A simple promise based sleep for testing.
 * @param {*} ms The amount of ms to sleep.
 * @returns Promise based sleep.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// Main functions
/**
 * Handles sending printing task to the different locations.
 * @param {*} order The order to print.
 */
async function printOrder(order) {
  let orderId = order.id;
  let mergedProducts;
  //Depending on register, select where to print from.
  switch (order.register) {
    case "Kassa Uppe 1":
      // This order is from register 1.
      // 1. print cust receipt.
      mergedProducts = order.productsKitchen.concat(order.productsRegister);
      logger.info(
        `[OID: ${order.id}] Priting customer copy at '${
          order.register
        }', following items: ${JSON.stringify(mergedProducts)}`
      );
      if(order.meme){
        registerOne.printOrderCustomer(orderId, mergedProducts, order.meme);
      }else{
        registerOne.printOrderCustomer(orderId, mergedProducts, undefined);
      }
      await sleep(2000); // TODO: Remove this sleep.
      // 2. print at kitchen if kitcharr >= 1.
      if (order.productsKitchen.length >= 1) {
        logger.info(
          `[OID: ${
            order.id
          }] Priting at 'Kitchen', following items: ${JSON.stringify(
            mergedProducts
          )}`
        );
        kitchen.printOrderInternal(
          order.register,
          orderId,
          order.productsKitchen
        );
        await sleep(2000); // TODO: Remove this sleep.
      }
      // 3. print at register if regarr >= 1.
      if (order.productsRegister.length >= 1) {
        logger.info(
          `[OID: ${order.id}] Priting at '${
            order.register
          }', following items: ${JSON.stringify(mergedProducts)}`
        );
        registerOne.printOrderInternal(
          order.register,
          orderId,
          order.productsRegister
        );
        await sleep(2000); // TODO: Remove this sleep.
      }
      break;
    case "Kassa Uppe 2":
      // This order is form register 2.
      // 1. print cust receipt.
      mergedProducts = order.productsKitchen.concat(order.productsRegister);
      logger.info(
        `[OID: ${order.id}] Priting customer copy at '${
          order.register
        }', following items: ${JSON.stringify(mergedProducts)}`
      );
      if(order.meme){
        registerTwo.printOrderCustomer(orderId, mergedProducts, order.meme);
      }else{
        registerTwo.printOrderCustomer(orderId, mergedProducts, undefined);
      }
      await sleep(2000);
      // 2. print at kitchen if kitcharr >= 1.
      if (order.productsKitchen.length >= 1) {
        logger.info(
          `[OID: ${
            order.id
          }] Priting at 'Kitchen', following items: ${JSON.stringify(
            mergedProducts
          )}`
        );
        kitchen.printOrderInternal(
          order.register,
          orderId,
          order.productsKitchen
        );
        await sleep(2000);
      }
      // 3. print at register if regarr >= 1.
      if (order.productsRegister.length >= 1) {
        logger.info(
          `[OID: ${order.id}] Priting at '${
            order.register
          }', following items: ${JSON.stringify(mergedProducts)}`
        );
        registerTwo.printOrderInternal(
          order.register,
          orderId,
          order.productsRegister
        );
        await sleep(2000);
      }
      break;
  }
}
/**
 * This function handles incoming orders and sorts the products to kitchen/register.
 * @param {Array} order An order directly from Zettle
 * @returns {Array} A order object made for the printing function.
 */
async function handleIncomingOrder(order) {
  return new Promise((res, rej) => {
    //Get the name of the register. "order.userDisplayName"
    let registerName = order.userDisplayName;
    //Get the products. "order.products"
    let productsKitchen = [];
    let productsRegister = [];
    for (product of order.products) {
      switch (product.name) {
        case "Mat - Köket": // If food from kitchen push to kitchen print.
          productsKitchen.push({
            amnt: product.quantity,
            item: product.variantName,
            extra: product.comment || null,
          });
          break;
        case "Mat - Baren": // If food from the bar push to register print.
          productsRegister.push({
            amnt: product.quantity,
            item: product.variantName,
            extra: product.comment || null,
          });
          break;
      }
    }
    res({
      register: registerName,
      productsKitchen: productsKitchen,
      productsRegister: productsRegister,
    });
  });
}
async function alreadyChecked(purId) {
  pur = await keyv.get(purId);
  if(pur == null){
    await keyv.set(purId, true);
    return false;
  }
  return true;
}
/**
 * This function calls the Zettle orders API to check for new orders.
 */
async function checkForIncomingOrders() {
  logger.info("Fetching last 5 orders...");
  let ordersToProcess = await api.getLatestPurchases(5, true);
  let toHandle = [];
  for (order of ordersToProcess.purchases) {
    let ord = await handleIncomingOrder(order);
    if (ord.productsKitchen.length > 0 || ord.productsRegister.length > 0) {
      let done = await alreadyChecked(order.purchaseUUID)
      if(done){
        continue;
      }
      ord.id = await newOrderId();
      toHandle.push(ord);
    }
  }
  for (order of toHandle) {
    await printOrder(order);
  }
  await sleep(5000);
  checkForIncomingOrders();
}
logger.info("Starting up...");

checkForIncomingOrders();
