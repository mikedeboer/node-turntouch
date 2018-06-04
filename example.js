#!/usr/bin/env node

var Noble = require("noble");
var TurnTouch = require("./index");

var gTurnTouch;

Noble.on("stateChange", function(state) {
  if (state == "poweredOn") {
    gTurnTouch = new TurnTouch(Noble);
    gTurnTouch.on("button", button => {
      console.log("BUTTON EVENT", button);
    });
    gTurnTouch.on("battery", batteryLevel => {
      console.log("BATTERY LEVEL", batteryLevel + "%");
    });
    gTurnTouch.on("error", err => console.error(err));
  } else {
    process.exit();
  }
});

process.on("exit", function() {
  Noble.stopScanning();
  if (gTurnTouch) {
    gTurnTouch.disconnect();
  }
});
