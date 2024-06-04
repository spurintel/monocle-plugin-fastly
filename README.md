# Monocle by Spur
[![Deploy to Fastly](https://deploy.edgecompute.app/button)](https://deploy.edgecompute.app/deploy)

Deploy a Fastly Compute project with Monocle that will automatically protect your site from residential proxies, malware proxies, or other commercial anonymity services.

For more details see the [Fastly Documentation Hub](https://www.fastly.com/documentation/solutions/starters)

## Description

Monocle can detect a user session coming from a residential proxy, malware proxy, or other endpoint based proxy network. By detecting this at the session level, you can take action on abusive users without impacting legitimate ones.

[Monocle](https://spur.us/monocle)  
[Docs](https://docs.spur.us/#/monocle)  
[FAQ](https://spur.us/monocle/#faqs)  
[Demo](https://spur.us/app/demos/monocle/form)  
[Blog](https://spur.us/announcing-monocle-community-edition) 

This Fastly Compute project will automatically force a Monocle render on new users before allowing them access to your site. Authentic users will not be negatively impacted. The cookie that this plugin sets for the user is good for an hour or whenever the user changes IP addresses.

An example of this project running in Fastly Compute is currently available at https://mcl.edgecompute.app/

## Help and Support

support@spur.us

## Setup

1. Sign up for a [Fastly account](https://fastly.com/).
2. Sign up for a [Spur account](https://spur.us/).
3. Install the [Fastly CLI client](https://developer.fastly.com/reference/cli).
4. Get your tokens from the [Monocle management](https://app.spur.us/monocle) page and set them in `src/index.js`.  
    ```
    const SITE_TOKEN = "YOURSITETOKENHERE";
    const API_TOKEN = "YOURAPITOKENHERE";
    ```
5. Create a new [Fastly compute service](https://manage.fastly.com/compute).  
    The "Create service" button will guide you through setting up a new service


You should use the [Fastly secret store](https://www.fastly.com/documentation/reference/api/services/resources/secret-store/) for at least the API token.  An example using the secret store is included but commented out because it requires additional Fastly account setup.
