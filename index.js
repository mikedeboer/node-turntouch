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
  "ef00": "north double tap",
  "feff": "north hold",
  "fd00": "east",
  "df00": "east double tap",
  "fdff": "east hold",
  "fb00": "west",
  "bf00": "west double tap",
  "fbff": "west hold",
  "f700": "south",
  "7f00": "south double tap",
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

const DOUBLETAP_DEBOUNCE_TIMEOUT_MS = 250;
const BATTERY_POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes.

var TurnTouch = module.exports = function(poweredNoble) {
  this.noble = poweredNoble;
  this.setup();
};

TurnTouch.prototype = {
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
  },

  async discoverAndConnect() {
    this.noble.startScanning([], true, err => {
      if (err) {
        throw new Error("Couldn't start scanning: " + err);
      }
    });

    return new Promise((resolve, reject) => {
      this.noble.on("discover", peripheral => {
        if (!peripheral.advertisement || !peripheral.advertisement.localName ||
            !peripheral.advertisement.localName.startsWith("Turn Touch")) {
          return;
        }

        this.noble.stopScanning();
        peripheral.connect(err => {
          if (err) {
            reject(new Error("Couldn't connect to remote: " + err));
            return;
          }

          this.peripheral = peripheral;
          resolve();
        });
      });
    });
  },

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
    this.buttonData.on("data", this.onButtonData.bind(this));
  },

  onButtonData(data) {
    let button = BUTTONS[data.toString("hex")];
    if (button == "off") {
      if (this._currentButtonBetweenOffs) {
        if (this._doubleTapDebounceTimer) {
          // Bail out, we're waiting for a double tap.
          return;
        }
        this._doubleTapDebounceTimer = setTimeout(this.resetButtonTracker.bind(this),
          DOUBLETAP_DEBOUNCE_TIMEOUT_MS);
      }/* else {} // 'off' received with no prior button press; ignore. */
    } else {
      this._currentButtonBetweenOffs = button;
      if (button.endsWith("double tap") || button.endsWith("hold")) {
        this.resetButtonTracker();
      }
    }
  },

  resetButtonTracker() {
    clearTimeout(this._doubleTapDebounceTimer);
    this._doubleTapDebounceTimer = null;
    if (this._currentButtonBetweenOffs) {
      this.emit("button", this._currentButtonBetweenOffs);
    }
    this._currentButtonBetweenOffs = null;
  },

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

    this.emit("battery", await this.getBatteryLevel());
  },

  batteryGaugePoll() {
    if (this._batteryTimer) {
      return;
    }

    this._batteryTimer = setTimeout(async () => {
      this.emit("battery", await this.getBatteryLevel());
      this.batteryGaugePoll();
    }, BATTERY_POLL_TIMEOUT_MS);
  },

  async getBatteryLevel() {
    return new Promise((resolve, reject) => {
      this.batteryData.read((err, data) => {
        if (err) {
          reject(new Error("Reading battery failed: " + err));
          return;
        }

        resolve(data.readIntBE(0, data.length));
      })
    });
  },

  disconnect() {
    if (this._batteryTimer) {
      clearTimeout(this._batteryTimer);
    }
    if (this.buttonData) {
      this.resetButtonTracker();
      // No callback to watch for errors here, because disconnect() should be
      // synchronous.
      this.buttonData.unsubscribe();
    }
    if (this.peripheral) {
      this.peripheral.disconnect();
    }
  }
};

Util.inherits(TurnTouch, Events.EventEmitter);
