// Synthetic QR, scan, and signed device list checked with the original shipped WASM.
export const trustedDevicePairingFixture = {
  "token": "fixture-token",
  "timestamp": 1700000000000,
  "desktopQr": "Z1@!krf!_!eM%=#?^+ltoLY3D4YiT2Y`?)lD6KY~[T^(UKdfpx&XaW<*yam;zVGVXaLc=h><{2$%&8^Qnmrc=h><{2$%&8^Qnmrc=h><{$CwW!eW4sRXDA",
  "webQr": "Z1@!krf!_!eM%=#?^+ltoLY3D4YiT2Y`?)lD6KY~[T^(UKdfpx&XaW<*yam;zVGVXaLc=h><{2$%&8^Qnmrc=h><{2$%&8^Qnmrc=h><{$CwW!eW4sR",
  "scan": {
    "enc_link_data": "CmUKEHN5bnRoZXRpYy1tYXN0ZXISIQUbG1jdUOoUtg2he3kM0CdU2XDJurhk67PA8wFv5R0/VxohBWA0bnyRGl9roVQSkXTK/nWylKw7vVVJYy9IzsYmb4QQICoogYCAgICAgBAwARJAbRfncBDxEUtiaZfymjJ48/S+dmUHI8RuIG9UJM7r/U5Tl5lvYysDw0wdIQLBsu/Ls+ViBZFDBNWAwBft6ac6ABkAaOXPiwEAAA==",
    "enc_link_hmac": "QOMDlX7Z28x4wLzsTLkcHe54H/aOWvITbxyB2IOGJ7k="
  },
  "proof": {
    "encLinkingMetaData": "ChBzeW50aGV0aWMtbWFzdGVyEiEFGxtY3VDqFLYNoXt5DNAnVNlwybq4ZOuzwPMBb+UdP1caIQVgNG58kRpfa6FUEpF0yv51spSsO71VSWMvSM7GJm+EECAqKIGAgICAgIAQMAE=",
    "encAccountSign": "bRfncBDxEUtiaZfymjJ48/S+dmUHI8RuIG9UJM7r/U5Tl5lvYysDw0wdIQLBsu/Ls+ViBZFDBNWAwBft6ac6AA==",
    "encDeviceSign": "tn2V33B6Z4C421IFKROF0oLhwctqqNptjZanQK9LTC47yrQxur3wNv8rS5yfOqoaFCx8sX2xxxa4hirAzYiyiQ==",
    "encPK": "BWA0bnyRGl9roVQSkXTK/nWylKw7vVVJYy9IzsYmb4QQ"
  },
  "approved": {
    "devices": {
      "masterId": "synthetic-master",
      "encIdentity": "BRsbWN1Q6hS2DaF7eQzQJ1TZcMm6uGTrs8DzAW/lHT9X",
      "lastUpdateTs": 1700000000000,
      "encSignature": "62ScwTehAbeuxxfWLCNvf9ANI7HZbujBpRienIrvjyu3JIIxfLNyEu53SfBqA1g06GZiXb42nteF2uRsyw1vBg==",
      "companions": [
        {
          "id": 42,
          "linkId": "9007199254740993",
          "encIdentity": "BWA0bnyRGl9roVQSkXTK/nWylKw7vVVJYy9IzsYmb4QQ",
          "platform": 2,
          "status": 1,
          "expireTs": 1700000060000,
          "encAccSign": "bRfncBDxEUtiaZfymjJ48/S+dmUHI8RuIG9UJM7r/U5Tl5lvYysDw0wdIQLBsu/Ls+ViBZFDBNWAwBft6ac6AA==",
          "encDeviceSign": "EAmE010FO5U7uGUKdA6FZlmzsHcHn/fCPOw1G/F4HzvmFDU1nV3Qg/wChbi9fgaeqha54VoT+4C87TPKKuwohg=="
        }
      ]
    }
  }
};
