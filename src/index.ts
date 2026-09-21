/// <reference types="@fastly/js-compute" />
import { handle } from './handler';

addEventListener('fetch', (event) => event.respondWith(handle(event)));
