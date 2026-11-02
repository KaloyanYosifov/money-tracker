// Makes the TOTP code for login.yaml right before the flow types it, so a slow launch or a slow
// iPad keyboard cannot let the code expire.
// Env: TOTP_SECRET (base32) and MIN_STEP, the first 30-second step that the API did not see yet.
// It uses the next step. The API accepts the steps from now-30s to now+30s, so the code stays
// valid for at least 60 seconds. Maestro scripts have no crypto module, so SHA-1 is written here.

function base32ToBytes(text) {
  var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  var bits = 0;
  var value = 0;
  var bytes = [];
  var clean = text.replace(/=+$/, "").toUpperCase();
  for (var i = 0; i < clean.length; i++) {
    var index = alphabet.indexOf(clean.charAt(i));
    if (index < 0) throw new Error("TOTP_SECRET is not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return bytes;
}

function rotl(x, n) {
  return (x << n) | (x >>> (32 - n));
}

function sha1(bytes) {
  var message = bytes.slice();
  var bitLength = bytes.length * 8;
  message.push(0x80);
  while (message.length % 64 !== 56) message.push(0);
  for (var s = 56; s >= 0; s -= 8) message.push(s >= 32 ? 0 : (bitLength >>> s) & 0xff);

  var h0 = 0x67452301;
  var h1 = 0xefcdab89;
  var h2 = 0x98badcfe;
  var h3 = 0x10325476;
  var h4 = 0xc3d2e1f0;
  var w = new Array(80);
  for (var block = 0; block < message.length; block += 64) {
    for (var t = 0; t < 16; t++) {
      var o = block + t * 4;
      w[t] = (message[o] << 24) | (message[o + 1] << 16) | (message[o + 2] << 8) | message[o + 3];
    }
    for (var t2 = 16; t2 < 80; t2++) w[t2] = rotl(w[t2 - 3] ^ w[t2 - 8] ^ w[t2 - 14] ^ w[t2 - 16], 1);
    var a = h0;
    var b = h1;
    var c = h2;
    var d = h3;
    var e = h4;
    for (var j = 0; j < 80; j++) {
      var f;
      var k;
      if (j < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (j < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (j < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      var temp = (rotl(a, 5) + f + e + k + w[j]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  var out = [];
  [h0, h1, h2, h3, h4].forEach(function (h) {
    out.push((h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff);
  });
  return out;
}

function hmacSha1(key, message) {
  if (key.length > 64) key = sha1(key);
  var inner = [];
  var outer = [];
  for (var i = 0; i < 64; i++) {
    var byte = i < key.length ? key[i] : 0;
    inner.push(byte ^ 0x36);
    outer.push(byte ^ 0x5c);
  }
  return sha1(outer.concat(sha1(inner.concat(message))));
}

function totpAt(secret, step) {
  var counter = [0, 0, 0, 0, (step >>> 24) & 0xff, (step >>> 16) & 0xff, (step >>> 8) & 0xff, step & 0xff];
  var hash = hmacSha1(base32ToBytes(secret), counter);
  var offset = hash[19] & 0x0f;
  var number = ((hash[offset] & 0x7f) << 24) | (hash[offset + 1] << 16) | (hash[offset + 2] << 8) | hash[offset + 3];
  var code = String(number % 1000000);
  while (code.length < 6) code = "0" + code;
  return code;
}

var nextStep = Math.floor(Date.now() / 30000) + 1;
if (Number(MIN_STEP) > nextStep) throw new Error("MIN_STEP " + MIN_STEP + " is after the next step " + nextStep);
output.totp = totpAt(TOTP_SECRET, nextStep);
