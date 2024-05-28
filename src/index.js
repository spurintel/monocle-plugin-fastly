/// <reference types="@fastly/js-compute" />

import { includeBytes } from "fastly:experimental";

import * as cookie from "cookie";

// This example uses Spur Monocle
// To start using Monocle, you need to register at https://app.spur.us/monocle
// and get an API key pair. The key pair consists of a site token and a secret api token used to decrypt the results.
const SITE_TOKEN = "";
const SECRET_API_TOKEN = "";
const PROTECTED_CONTENT =
  "<iframe src='https://developer.fastly.com/compute-welcome' style='border:0; position: absolute; top: 0; left: 0; width: 100%; height: 100%'></iframe>\n";
// const CAPTCHA_FORM = `
// <html>
//   <head>
//     <title>Monocle demo: Simple page</title>
//     <script src="https://mcl.spur.us/d/mcl.js?tk=${SITE_TOKEN}" async defer></script>
//   </head>
//   <body>
//     <form action="?captcha=true" method="POST">
//     <div class="monocle"></div>
//     <br/>
//     <input type="submit" value="Submit">
//     </form>
//   </body>
// </html>
// `;

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

// load captcha page
const CAPTCHA_FORM = searchAndReplace(includeBytes("./src/captcha_page.html"), "SITE_TOKEN", SITE_TOKEN);

async function handleCaptchaRequest(req) {
  const body = await req.text();
  console.log(body);
  // Extract the user's response token from the POST body
  // and verify it with the reCAPTCHA API.
  const captchaURL = `https://decrypt.mcl.spur.us/api/v1/assessment`;
  let headers = new Headers();
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("TOKEN", SECRET_API_TOKEN);
  const captchaReq = new Request(captchaURL, {
    method: 'POST',
    body: body.data,
    headers
  });
  const cacheOverride = new CacheOverride("pass");

  console.log("Sending to CAPTCHA API to verify");
  let res = await fetch(captchaReq, {
    backend: "mcl_assessment",
    cacheOverride
  });

  const result = await res.text();
  console.log(result);
  return result.success || false;
}

async function handleRequest(event) {
  let req = event.request;
  let url = new URL(req.url);
  const isChallenge = url.searchParams.has("captcha");

  console.log(url);
  if (req.method === "POST" && isChallenge) {
    const isPass = await handleCaptchaRequest(req);
    if (isPass) {
      // It's a pass! Set a cookie, so that this user is not challenged again within an hour.
      // You would probably want to make this cookie harder to fake.
      // If isPass is false, fall through to the remainder of the function and redisplay the CAPTCHA form.
      url.searchParams.delete("captcha");
      let headers = new Headers();
      headers.set("Cache-Control", "private, no-store");
      headers.set("Set-Cookie", "captchaAuth=1; path=/; max-age=3600");
      headers.set("Location", url);

      return new Response("", { status: 302, headers });
    }
  }

  let headers = new Headers();
  headers.set("Content-Type", "text/html; charset=utf-8");

  let body = CAPTCHA_FORM;
  if (req.headers.has("Cookie")) {
    const cookies = cookie.parse(req.headers.get("Cookie"));
    if (cookies.captchaAuth === "1") {
      body = PROTECTED_CONTENT;
    }
  }
  return new Response(body, { status: 200, headers });

}

addEventListener("fetch", (event) => event.respondWith(handleRequest(event)));
