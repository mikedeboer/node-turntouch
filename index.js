const Events = require("events");
const Util = require("util");

const UUIDS = {
  BUTTON_SERVICE: "99c31523dc4f41b1bb044e4deb81fadd",
  BUTTON_CHARACTERISTIC: "99c31525dc4f41b1bb044e4deb81fadd",
  BATTERY_SERVICE: "180f",
  BATTERY_CHARACTERISTIC: "2a19",
  DEVICE_CHARACTERISTIC: "99c31526dc4f41b1bb044e4deb81fadd"
};

const BUTTONS = {
  "ff00": "off",
  "fe00": "north",
  "ef00": "north double-tap",
  "feff": "north hold",
  "fd00": "east",
  "df00": "east double-tap",
  "fdff": "east hold",
  "fb00": "west",
  "bf00": "west double-tap",
  "fbff": "west hold",
  "f700": "south",
  "7f00": "south double-tap",
  "f7ff": "south hold",
  "fc00": "multi-touch north + east",
  "fa00": "multi-touch north + west",
  "f600": "multi-touch north + south",
  "f900": "multi-touch east + west",
  "f500": "multi-touch east + south",
  "f300": "multi-touch west + south",
  "f800": "multi-touch north + east + west",
  "f400": "multi-touch north + east + south",
  "f200": "multi-touch north + west + south",
  "f100": "multi-touch east + west + south",
  "f000": "multi-touch north + east + west + south"
};

var BUTTON_EVENTDATA;

const DOUBLETAP_DEBOUNCE_TIMEOUT_MS = 250;
const HOLD_REPEAT_TIMEOUT_MS = 10;
const BATTERY_POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes.

const DEBUG = false;
const LOG = (...args) => {
  if (!DEBUG) {
    return;
  }
  console.log("DEBUG TurnTouch:: ", ...args);
};

/**
 * TurnTouch class, which allows you to connect to your TurnTouch remote, query
 * it for info and receive events from it.
 *
 * @category API
 * @implements {events.EventEmitter}
 * @example <caption>Simple bootstrapping</caption>
 * var Noble = require("noble");
 * var TurnTouch = require("turntouch");
 *
 * var gTurnTouch;
 *
 * Noble.on("stateChange", function(state) {
 *   console.log("Noble state change.", state);
 *   if (state == "poweredOn") {
 *     gTurnTouch = new TurnTouch(Noble);
 *     gTurnTouch.on("button", button => {
 *       console.log("BUTTON EVENT", button);
 *     });
 *     gTurnTouch.on("battery", batteryLevel => {
 *       console.log("BATTERY LEVEL", batteryLevel + "%");
 *     });
 *     gTurnTouch.on("error", err => console.error(err));
 *   } else {
 *     process.exit();
 *   }
 * });
 *
 * process.on("exit", function() {
 *   Noble.stopScanning();
 *   if (gTurnTouch) {
 *     gTurnTouch.disconnect();
 *   }
 * });
 */
class TurnTouch {
  /**
   * @param {Noble} poweredNoble Instance of the Noble BLE library.
   */
  constructor(poweredNoble) {
    this.noble = poweredNoble;
    this.setup();
    this._events = new Map();
  }

  /**
   * Error event.
   *
   * @event TurnTouch#error
   * @type {Error}
   */

  /**
   * Powers on the Noble instance, if it's not running yet, and attempts to
   * discover and connect to the TurnTouch remote.
   * Once the connection is established successfully, it'll start listening for
   * button events and start the battery gauge.
   *
   * @fires TurnTouch#error
   * @return {Promise} Promise that resolves when done or when an error has
   *                   occurred.
   */
  async setup() {
    if (this.noble.state != "poweredOn") {
      await new Promise(resolve => {
        this.noble.once("stateChange", state => {
          if (state == "poweredOn") {
            resolve();
          } else {
            this.emit("error", new Error("Received an invalid state from Noble: " + state));
          }
        });
      });
    }

    try {
      await this.discoverAndConnect();

      // The remote doesn't support getting all services and characteristics at once,
      // so we need to do it in two passes; buttons and battery.
      await this.setupButtonListener();

      await this.setupBatteryGauge();
    } catch (ex) {
      this.emit("error", ex);
    }
  }

  /**
   * Starts scanning for Bluetooth devices and tries to filter out the TurnTouch
   * remote. When it's discovered, and attempt to make a connection is done.
   * This method is called by {@link TurnTouch#setup}, so you probably won't
   * need it.
   *
   * @see TurnTouch#setup
   * @throws {Error}   If the connection with the remote could not be established.
   * @return {Promise} Promise that resolves when done.
   */
  async discoverAndConnect() {
    return new Promise((resolve, reject) => {
      this.noble.startScanning([], true, err => {
        if (err) {
          throw new Error("Couldn't start scanning: " + err);
        }

        LOG("Scanning started.");
        let handler;
        this.noble.on("discover", handler = peripheral => {
          if (!peripheral.advertisement || !peripheral.advertisement.localName ||
              !peripheral.advertisement.localName.startsWith("Turn Touch")) {
            return;
          }

          LOG("Peripheral DISCOVERED.", peripheral);
          this.noble.off("discover", handler);
          this.noble.stopScanning();
          peripheral.connect(err => {
            if (err) {
              reject(new Error("Couldn't connect to remote: " + err));
              return;
            }

            this.peripheral = peripheral;
            this._events.set("disconnect", this.onDisconnect.bind(this));
            peripheral.on("disconnect", this._events.get("disconnect"));
            resolve();
          });
        });
      });
    });
  }

  /**
   * Discover the button service of the remote and attempts to subscribe to data
   * from it, which will contain button press events.
   * This method is called by {@link TurnTouch#setup}, so you probably won't
   * need it.
   *
   * @see TurnTouch#setup
   * @throws {Error}   If there's no connection with the remote yet, when the
   *                   button service can not be discovered or when subscription
   *                   to button events fails.
   * @return {Promise} Promise that resolves when done.
   */
  async setupButtonListener() {
    if (!this.peripheral) {
      throw new Error("Fatal error: connect to the remote first.");
    }

    await new Promise((resolve, reject) => {
      this.peripheral.discoverSomeServicesAndCharacteristics([UUIDS.BUTTON_SERVICE],
        [UUIDS.BUTTON_CHARACTERISTIC], (err, services, characteristics) => {
          if (err) {
            reject(new Error("Button data discovery failed: " + err));
            return;
          }

          this.buttonData = characteristics[0];
          resolve();
        });
    });

    this.resetButtonTracker();
    await new Promise((resolve, reject) => {
      this.buttonData.subscribe(err => {
        if (err) {
          reject(new Error("Button data subscribe failed: " + err));
          return;
        }
        resolve();
      });
    });
    this._events.set("data", this.onButtonData.bind(this));
    this.buttonData.on("data", this._events.get("data"));
  }

  /**
   * Event handler, invoked when a button event comes in through the
   * subscription as made in {@link TurnTouch#setupButtonListener}.
   *
   * @param {Buffer} data NodeJS Buffer object that signifies the button event.
   *                      This should match with one of the hex codes in the
   *                      `BUTTONS` map (see source code).
   */
  onButtonData(data) {
    let button = BUTTONS[data.toString("hex")];
    if (button == "off") {
      if (this._currentButtonBetweenOffs) {
        LOG("Button OFF.", this._holdRepeatTimer);
        if (this._holdRepeatTimer) {
          clearInterval(this._holdRepeatTimer);
          this._holdRepeatTimer = null;
          return;
        }
        if (this._doubleTapDebounceTimer) {
          // Bail out, we're waiting for a double-tap.
          return;
        }
        this._doubleTapDebounceTimer = setTimeout(this.resetButtonTracker.bind(this),
          DOUBLETAP_DEBOUNCE_TIMEOUT_MS);
      }/* else {} // 'off' received with no prior button press; ignore. */
    } else {
      this._currentButtonBetweenOffs = button;
      if (button.endsWith("double-tap") || button.endsWith("hold")) {
        this.resetButtonTracker();
      }
    }
  }

  /**
   * Button Event.
   *
   * @typedef {object} ButtonEvent
   * @property {string} button Name of the button that was pressed. May be
   *                           'north', 'east', 'south', 'west' or 'multi-touch'.
   * @property {boolean} hold `true` when the button was held down for longer
   *                          than `HOLD_REPEAT_TIMEOUT_MS` milliseconds.
   * @property {boolean} doubleTap `true` when the button was tapped twice in
   *                               quick succession.
   * @property {array<string>} buttons List of buttons that were tapped
   *                                   simultaneously. This only contains items
   *                                   for the 'multi-touch' event.
   */
  /**
   * Button event.
   *
   * @event TurnTouch#button
   * @type {ButtonEvent}
   */

  /**
   * Creates a nice, inspectable event object that
   * @param  {string} buttonString Textual representation of the button event
   *                               that was captured.
   * @return {ButtonEvent}
   */
  createEvent(buttonString) {
    if (!BUTTON_EVENTDATA) {
      BUTTON_EVENTDATA = {};
      for (let btn of Object.values(BUTTONS)) {
        let [button, ...modifiers] = btn.split(/[\s+]+/);
        BUTTON_EVENTDATA[btn] = {
          button,
          hold: modifiers.includes("hold"),
          doubleTap: modifiers.includes("double-tap"),
          buttons: []
        };
        if (button == "multi-touch") {
          BUTTON_EVENTDATA[btn].buttons.push(...modifiers);
        }
      }
    }
    return Object.assign({}, BUTTON_EVENTDATA[buttonString]);
  }

  /**
   * Part of the double-tap debouncing mechanism; it makes sure that a certain
   * amount of time between taps is allowed to not send events for a single AND
   * double tap, but to de-duplicate.
   * When a button is held down, this method is responsible for firing multiple
   * {@link ButtonEvent}s every `HOLD_REPEAT_TIMEOUT_MS` milliseconds.
   *
   * @fires TurnTouch#button
   */
  resetButtonTracker() {
    clearTimeout(this._doubleTapDebounceTimer);
    this._doubleTapDebounceTimer = null;
    if (this._currentButtonBetweenOffs) {
      let event = this.createEvent(this._currentButtonBetweenOffs);
      LOG("Button pressed.", event);
      this.emit("button", event);
      if (event.hold && !this._holdRepeatTimer) {
        this._holdRepeatTimer = setInterval(() => {
          LOG("Holding button depressed.", event);
          this.emit("button", event);
        }, HOLD_REPEAT_TIMEOUT_MS);
      }
    }
    this._currentButtonBetweenOffs = null;
  }

  /**
   * Start gauging the battery level of the remote continuously, at a set
   * interval of `BATTERY_POLL_TIMEOUT_MS` milliseconds.
   *
   * @throws {Error}   If there's no connection with the remote yet or when the
   *                   battery service can not be discovered.
   * @return {Promise} Promise that resolves when done.
   * @see TurnTouch#getBatteryLevel
   */
  async setupBatteryGauge() {
    if (!this.peripheral) {
      throw new Error("Fatal error: connect to the remote first.");
    }

    await new Promise((resolve, reject) => {
      this.peripheral.discoverSomeServicesAndCharacteristics([UUIDS.BATTERY_SERVICE],
        [UUIDS.BATTERY_CHARACTERISTIC], (err, services, characteristics) => {
          if (err) {
            reject(new Error("Battery data discovery failed: " + err));
            return;
          }

          this.batteryData = characteristics[0];
          resolve();
        });
    });

    this.batteryGaugePoll();

    await this.getBatteryLevel();
  }

  /**
   * Start polling for the battery level every `BATTERY_POLL_TIMEOUT_MS`
   * milliseconds.
   */
  batteryGaugePoll() {
    if (this._batteryTimer) {
      return;
    }

    this._batteryTimer = setTimeout(async () => {
      await this.getBatteryLevel();
      this.batteryGaugePoll();
    }, BATTERY_POLL_TIMEOUT_MS);
  }

  /**
   * Battery event.
   *
   * @event TurnTouch#battery
   * @type {number}
   */

  /**
   * Read the battery level from the remote's battery service.
   *
   * @fires TurnTouch#battery
   * @throws {Error} If reading the battery level failed somehow.
   * @return {Promise<number>} Promise that resolves with the battery level
   *                           when done or rejects with an error upon failure.
   */
  async getBatteryLevel() {
    return new Promise((resolve, reject) => {
      this.batteryData.read((err, data) => {
        if (err) {
          reject(new Error("Reading battery failed: " + err));
          return;
        }

        let level = data.readIntBE(0, data.length);
        LOG("Battery.", level);
        this.emit("battery", level);
        resolve(level);
      })
    });
  }

  /**
   * Disconnect from the remote and clean up thoroughly.
   */
  disconnect() {
    if (this._batteryTimer) {
      clearTimeout(this._batteryTimer);
      this._batteryTimer = null;
    }
    if (this.buttonData) {
      this.resetButtonTracker();
      // No callback to watch for errors here, because disconnect() should be
      // synchronous.
      this.buttonData.off("data", this._events.get("data"));
      this.buttonData.unsubscribe();
      this.buttonData = null;
    }
    this.peripheral.off("disconnect", this._events.get("disconnect"));
    if (this.peripheral) {
      this.peripheral.disconnect();
    }
    this.peripheral = null;
    this._events.clear();
  }

  /**
   * Event handler that fired when the connection between Noble and the remote
   * is gone.
   * It will re-connect automatically when the disconnect was unintential, i.e.
   * without having called {@link TurnTouch#disconnect}.
   */
  onDisconnect() {
    let restart = !!this.peripheral;
    this.peripheral = null;
    this.disconnect();
    if (restart) {
      LOG("Reconnecting.");
      this.setup();
    }
  }
};

Util.inherits(TurnTouch, Events.EventEmitter);

/**
 * @exports TurnTouch
 */
module.exports = TurnTouch;
