/// <reference types="@fastly/js-compute" />

// import { SecretStore } from "fastly:secret-store";
import { includeBytes } from "fastly:experimental";

import * as cookie from "cookie";

// This example uses Spur Monocle
// To start using Monocle, you need to register at https://app.spur.us/monocle
// and get an API key pair. The key pair consists of a site token and a secret api token used to decrypt the results.
// const secrets = new SecretStore('example-secrets-service-a')
// const SITE_TOKEN = await secrets.get("SITE_TOKEN");
// const API_TOKEN = await secrets.get("API_TOKEN");


const PROTECTED_CONTENT =
  "<iframe src='https://developer.fastly.com/compute-welcome' style='border:0; position: absolute; top: 0; left: 0; width: 100%; height: 100%'></iframe>\n";

// Convert byte field to string
function bytesToString(bytes) {
  return String.fromCharCode.apply(null, bytes);
}

// Convert string to byte field
function stringToBytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; ++i) {
      bytes[i] = str.charCodeAt(i);
  }
  return bytes;
}

// Search and replace content in byte field
function searchAndReplace(bytes, searchString, replaceString) {
  // Convert bytes to string
  let str = bytesToString(bytes);
  
  // Perform search and replace operation
  str = str.replace(searchString, replaceString);
  
  // Convert modified string back to bytes
  return stringToBytes(str);
}

// Load html response pages as bytes at compile time
// Is this weird?  Yes!  Fastly doesn't expose the filesystem at runtime.
// You can also load html inline like PROTECTED_CONTENT above.
const CAPTCHA_FORM = searchAndReplace(includeBytes("./src/captcha_page.html"), "SITE_TOKEN", SITE_TOKEN);
const DENIED = includeBytes("./src/denied.html");
const SUCCESS = includeBytes("./src/success.html");

async function handleCaptchaRequest(req) {
  const body = await req.json();
  console.log(body)
  // Send the bundle for decryption
  const captchaURL = `https://decrypt.mcl.spur.us/api/v1/assessment`;
  let headers = new Headers();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("TOKEN", API_TOKEN);
  const captchaReq = new Request(captchaURL, {
    method: 'POST',
    body: body.captchaData,
    headers
  });
  const cacheOverride = new CacheOverride("pass");

  console.log("Sending to CAPTCHA API to verify");
  let res = await fetch(captchaReq, {
    backend: "mcl_assessment",
    cacheOverride
  });

  const result = await res.json();
  console.log("isanon " + result.anon)
  // return true if you want the captcha to pass
  // return false if you want the captcha to fail
  // Simply returning false for any anonymous connections for now 
  if ( result.anon ) {
    return false;
  } else {
    return true;
  }
}

async function handleRequest(event) {
  let req = event.request;
  let url = new URL(req.url);
  console.log(url);
  const isChallenge = url.pathname.includes("/validate_captcha");
  const isDenied = url.pathname.includes("/denied");

  let headers = new Headers();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "private, no-store");
  headers.set("Location", url);

  if (req.method === "POST" && isChallenge ) {
    const isPass = await handleCaptchaRequest(req);
    if (isPass) {
      console.log("PASSED")
      // It's a pass! Set a cookie, so that this user is not challenged again within an hour.
      // You would probably want to make this cookie harder to fake.
      headers.set("Location", url);
      headers.set("Set-Cookie", "captchaAuth=1; path=/; max-age=3600");
      return new Response("", { status: 302, headers });
    } else {
      console.log("DENIED")
      headers.set("Location", "/denied");
      headers.set("Set-Cookie", "captchaAuth=0; path=/; max-age=0");
      return new Response("", { status: 302, headers });
    }
  } else if ( req.method === "GET" && isDenied ) {
    console.log("IS DENIED")
    let body = searchAndReplace(DENIED, "REPLACE_ME", "SOME VPN OR PROXY");
    return new Response(body, { status: 200, headers });
  } else {
    console.log("CAPTCHA OR PASS")
    let body = CAPTCHA_FORM;
    if (req.headers.has("Cookie")) {
      console.log("HAS COOKIE")
      const cookies = cookie.parse(req.headers.get("Cookie"));
      if (cookies.captchaAuth === "1") {
        console.log("HAS CAPTCHA AUTH")
        body = SUCCESS;
      }
    }
    return new Response(body, { status: 200, headers });
  }
}

addEventListener("fetch", (event) => event.respondWith(handleRequest(event)));
