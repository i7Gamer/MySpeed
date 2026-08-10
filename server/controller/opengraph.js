import fs from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import moment from 'moment-timezone';
import * as tests from './speedtests.js';
import { parseDateRange } from '../util/dateRange.js';
import htm from 'htm';
import satori from 'satori';

const html = htm.bind((type, props, ...children) => ({type, props: {...props, children: children.flat()}}));

const hasValues = (test) => Boolean(test?.download.avg && test?.upload.avg && test?.ping.avg);

const readStatistics = async () => {
  const formatDate = (d) => d.toISOString().split('T')[0];
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const range = parseDateRange(formatDate(yesterday), formatDate(new Date()));
  if (!range.valid) return null;

  const stats = await tests.listStatistics(range);
  if (hasValues(stats)) return stats;

  const latest = await tests.getLatest();
  if (!latest || latest.error || latest.ping === -1) return null;

  return {ping: {avg: latest.ping}, download: {avg: latest.download}, upload: {avg: latest.upload}};
};

// The compiled binary ships the client inside the executable rather than on
// disk, so assets have to be readable from there too.
let embeddedClient = null;
try {
  embeddedClient = await import('../clientEmbed.js');
} catch {

}

/**
 * Loads a bundled asset.
 *
 * Reads from disk or from the embedded client, never over the network. This
 * used to fall back to fetching the asset from the running instance, building
 * the URL out of the request's own Host header - which an unauthenticated
 * caller controls, making the server issue a request to any host they named.
 * Returns null when the asset is not bundled; the caller falls back to the
 * project banner.
 */
const readAsset = async (path) => {
  const local = [`build${path}`, `client/public${path}`].find(candidate => fs.existsSync(candidate));
  if (local) return fs.promises.readFile(local);

  return embeddedClient?.readEmbeddedFile?.(path) ?? null;
};

async function renderOpenGraphImage() {
  const test = await readStatistics();

  if (!hasValues(test)) return null;

  const font = await readAsset("/assets/fonts/inter-v12-latin-regular.ttf");
  const logo = await readAsset("/assets/img/logo192.png");

  // satori cannot render without a font, and the markup embeds the logo - the
  // loader documents null as an ordinary answer for both, and the route shows
  // the project banner instead. The logo used to be embedded unchecked, which
  // turned its absence into a TypeError on every request.
  if (!font || !logo) return null;

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = moment().tz(timeZone).format("MM/DD/YYYY");
  const time = moment().tz(timeZone).format("h:mm A z");

  const markup = html`
    <div
      tw="bg-[#1d2332] text-white rounded-lg w-full h-full flex flex-col p-16 justify-between"
    >
      <div tw="w-full flex-row flex justify-between items-center">
        <div tw="flex flex-row items-center -mt-4">
          <div tw="h-full items-start flex">
            <svg
              width="100"
              height="100"
              aria-hidden="true"
              focusable="false"
              data-prefix="fas"
              data-icon="server"
              role="img"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 512 512"
            >
              <path
                fill="currentColor"
                d="M64 32C28.7 32 0 60.7 0 96v64c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V96c0-35.3-28.7-64-64-64H64zm280 72a24 24 0 1 1 0 48 24 24 0 1 1 0-48zm48 24a24 24 0 1 1 48 0 24 24 0 1 1 -48 0zM64 288c-35.3 0-64 28.7-64 64v64c0 35.3 28.7 64 64 64H448c35.3 0 64-28.7 64-64V352c0-35.3-28.7-64-64-64H64zm280 72a24 24 0 1 1 0 48 24 24 0 1 1 0-48zm56 24a24 24 0 1 1 48 0 24 24 0 1 1 -48 0z"
              ></path>
            </svg>
          </div>
          <p tw="text-[100px] leading-[74px] font-bold m-0 ml-4 p-0">MySpeed</p>
        </div>
        <div tw="flex flex-row h-full">
          <div tw="flex flex-col h-full justify-around items-end pr-1">
            <p tw="text-4xl  leading-[30px] text-slate-500 m-0 p-0">${date}</p>
            <span tw="text-4xl  leading-[30px] text-slate-500 m-0 p-0">
              ${time}
            </span>
          </div>
          <div tw="flex h-[100px] w-[100px] mr-[50px]">
            <img
              tw="-mt-[50px]"
              height=${200}
              width=${200}
              src="data:image/png;base64,${logo.toString("base64")}"
            />
          </div>
        </div>
      </div>
      <div tw="w-full justify-between flex-row flex mt-[50px]">
        <div tw="flex flex-col items-start">
          <div tw="flex flex-row items-center">
            <svg
              tw="text-[#44c459] mr-4"
              xmlns="http://www.w3.org/2000/svg"
              width="80"
              height="80"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" x2="12" y1="15" y2="3" />
            </svg>
            <div tw="flex flex-row items-end">
              <p tw="text-6xl m-0 p-0 font-semibold">DOWNLOAD</p>
              <p tw="text-4xl m-0 p-0 text-slate-500 ml-1">Mbps</p>
            </div>
          </div>
          <p tw="text-[160px] font-bold m-0 p-0">
            ${String(test.download.avg)}
          </p>
        </div>
        <div tw="flex flex-col items-end">
          <div tw="flex flex-row items-center">
            <svg
              tw="text-[#4469c4] mr-4"
              xmlns="http://www.w3.org/2000/svg"
              width="80"
              height="80"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" x2="12" y1="3" y2="15" />
            </svg>
            <div tw="flex flex-row items-end">
              <p tw="text-6xl m-0 p-0 font-semibold">UPLOAD</p>
              <p tw="text-4xl m-0 p-0 text-slate-500 ml-1">Mbps</p>
            </div>
          </div>
          <p tw="text-[160px] font-bold m-0 -mr-5 p-0">
            ${String(test.upload.avg)}
          </p>
        </div>
      </div>
      <div tw="w-full flex-row flex justify-end mt-4">
        <div tw="flex items-center">
          <svg
            width="40"
            tw="text-[#fbbd08]"
            aria-hidden="true"
            focusable="false"
            role="img"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 640 512"
          >
            <path
              fill="currentColor"
              d="M480 288c-50.1 0-93.6 28.8-114.6 70.8L132.9 126.3l.6-.6 60.1-60.1c87.5-87.5 229.3-87.5 316.8 0c67.1 67.1 82.7 166.3 46.8 248.3C535.8 297.6 509 288 480 288zM113.3 151.9L354.1 392.7c-1.4 7.5-2.1 15.3-2.1 23.3c0 23.2 6.2 44.9 16.9 63.7c-3 .2-6.1 .3-9.2 .3H357c-33.9 0-66.5-13.5-90.5-37.5l-9.8-9.8c-13.1-13.1-34.6-12.4-46.8 1.7L152.2 501c-5.8 6.7-14.2 10.7-23 11s-17.5-3.1-23.8-9.4l-32-32c-6.3-6.3-9.7-14.9-9.4-23.8s4.3-17.2 11-23l66.6-57.7c14-12.2 14.8-33.7 1.7-46.8l-9.8-9.8c-24-24-37.5-56.6-37.5-90.5v-2.7c0-22.8 6.1-44.9 17.3-64.3zM480 320a96 96 0 1 1 0 192 96 96 0 1 1 0-192z"
            ></path>
          </svg>
          <div tw="flex flex-row items-end">
            <p tw="text-5xl p-0 m-0">Ping</p>
            <p tw="text-4xl leading-9 text-slate-500 p-0 m-0">ms</p>
          </div>
          <div tw="flex pl-4">
            <p tw="text-5xl p-0 m-0">${String(test.ping.avg)}</p>
          </div>
        </div>
      </div>
    </div>
  `;

  const image = await satori(markup, {
    width: 1200,
    height: 600,
    fonts: [
      {
        name: "Inter",
        data: font,
        weight: 400,
        style: "normal",
      },
    ],
  });

  const svg = new Resvg(image);

  return svg.render().asPng();
}

/**
 * Renders at most once a minute, however many callers ask.
 *
 * The endpoint answers without a password and every request used to run satori
 * plus a full resvg rasterisation of a 1200x600 image - enough CPU that a
 * trivial request loop starved everything else on the single thread. The image
 * only shows statistics and a wall-clock minute, so a short cache costs nothing
 * in freshness. The in-flight promise is shared so a burst arriving on a cold
 * cache still renders once rather than once per request.
 */
const CACHE_TTL = 60000;

let cached = null;
let inFlight = null;

async function generateOpenGraphImage() {
  if (cached && Date.now() < cached.expiresAt) return cached.png;
  if (inFlight) return inFlight;

  inFlight = renderOpenGraphImage()
    .then((png) => {
      if (png) cached = {png, expiresAt: Date.now() + CACHE_TTL};
      return png;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

export default generateOpenGraphImage;
