// Synthetic signatures accepted or rejected by the installed Zalo trusted-device WASM.
export const trustedDeviceFixture = {
  "keys": {
    "primary": "BRsbWN1Q6hS2DaF7eQzQJ1TZcMm6uGTrs8DzAW/lHT9X",
    "companion": "BWA0bnyRGl9roVQSkXTK/nWylKw7vVVJYy9IzsYmb4QQ"
  },
  "fixtures": {
    "active": {
      "devices": {
        "masterId": "synthetic-master",
        "encIdentity": "BRsbWN1Q6hS2DaF7eQzQJ1TZcMm6uGTrs8DzAW/lHT9X",
        "lastUpdateTs": 1700000000000,
        "encSignature": "wuxjVT7aZ+MMckN/KUE7XVZ/AZE8okof/4VvyBOjX+PbxJ9p/76cvPiOw/nfrxCNzqc3++u6xQxAigS/KyRKCQ==",
        "companions": [
          {
            "id": 42,
            "linkId": "9007199254740993",
            "encIdentity": "BWA0bnyRGl9roVQSkXTK/nWylKw7vVVJYy9IzsYmb4QQ",
            "platform": 2,
            "status": 1,
            "expireTs": 1700000060000,
            "encAccSign": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
            "encDeviceSign": "EAmE010FO5U7uGUKdA6FZlmzsHcHn/fCPOw1G/F4HzvmFDU1nV3Qg/wChbi9fgaeqha54VoT+4C87TPKKuwohg=="
          }
        ]
      }
    },
    "stale": {
      "devices": {
        "masterId": "synthetic-🧪",
        "encIdentity": "BRsbWN1Q6hS2DaF7eQzQJ1TZcMm6uGTrs8DzAW/lHT9X",
        "lastUpdateTs": 1700000000000,
        "encSignature": "y1oZNHq1o8WoDDkYJVEPE2Qw9E/lbVDSrZJUWJ9kc19JqMFkjyLeH839sPL+fdNv+B1NKgs0rJynTpVOJ7jqAA==",
        "companions": [
          {
            "id": 0,
            "linkId": "0",
            "encIdentity": "BWA0bnyRGl9roVQSkXTK/nWylKw7vVVJYy9IzsYmb4QQ",
            "platform": 1,
            "status": 0,
            "expireTs": 1700000060000,
            "encAccSign": "",
            "encDeviceSign": "RX6xnfm7muqXxXp4oviXfpp2Dm2U+EYig/a8iatcSGycM2vRznLTzmLDQA1uWXOHPE6R5m4+qQmBqTid13MqgA=="
          }
        ]
      }
    },
    "missing": {
      "devices": {
        "masterId": "synthetic-master",
        "encIdentity": "BRsbWN1Q6hS2DaF7eQzQJ1TZcMm6uGTrs8DzAW/lHT9X",
        "lastUpdateTs": 1700000000000,
        "encSignature": "oI42/AYcRS4hmkvFV+hjYp1x4Vk9zTeuLLzVGtPI8tZutY/1iywqMBex5qA3ogKA/e6YBmhP8gAZ0nB0S13JBQ==",
        "companions": []
      }
    },
    "badDevice": {
      "devices": {
        "masterId": "synthetic-master",
        "encIdentity": "BRsbWN1Q6hS2DaF7eQzQJ1TZcMm6uGTrs8DzAW/lHT9X",
        "lastUpdateTs": 1700000000000,
        "encSignature": "48+lcigLrutRpze5V482AijGpL3j9qBLD9XfltIohEk+m2ru6073nmFJLTsP4bIsu6qkyMh8hAQ5+uU/0Fu+DQ==",
        "companions": [
          {
            "id": 42,
            "linkId": "9007199254740993",
            "encIdentity": "BWA0bnyRGl9roVQSkXTK/nWylKw7vVVJYy9IzsYmb4QQ",
            "platform": 2,
            "status": 1,
            "expireTs": 1700000060000,
            "encAccSign": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
            "encDeviceSign": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
          }
        ]
      }
    },
    "reversed": {
      "devices": {
        "masterId": "synthetic-master",
        "encIdentity": "BRsbWN1Q6hS2DaF7eQzQJ1TZcMm6uGTrs8DzAW/lHT9X",
        "lastUpdateTs": 1700000000000,
        "encSignature": "rqfh4nWVqP/Kkt9MS9649NTsH+faG2XevUl72VTP+fwM/V/3jA9MNnuYk3fn/f/3lxBfF19h5Ht1QKxthSI4CA==",
        "companions": [
          {
            "id": 30,
            "linkId": "18446744073709551615",
            "encIdentity": "BWA0bnyRGl9roVQSkXTK/nWylKw7vVVJYy9IzsYmb4QQ",
            "platform": 2,
            "status": 1,
            "expireTs": 1700000060000,
            "encAccSign": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
            "encDeviceSign": "VDK+Dsn8cQUsndxIPYlgSRiv1lm6Dp1JIYPANQgh2MemK1MtprwRB9Gja6sIfzd4ANFzPs/+7M9lj8eUP8eXgA=="
          },
          {
            "id": 4,
            "linkId": "2",
            "encIdentity": "BWA0bnyRGl9roVQSkXTK/nWylKw7vVVJYy9IzsYmb4QQ",
            "platform": 1,
            "status": 0,
            "expireTs": 1700000060000,
            "encAccSign": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
            "encDeviceSign": "75Y0fRVn5oto95Y2hkO8VoIjuClhnljfJYfAMmBLboe6K1+yp0nRCRhK695TuNkcTW79uPopLFJI0n2V+C2biA=="
          }
        ]
      }
    }
  }
};
