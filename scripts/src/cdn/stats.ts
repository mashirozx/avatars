import got from 'got';
import stream from 'stream';
import { promisify } from 'util';
import fs from 'fs-extra';
import path from 'path';
import ora from 'ora';
import prettyBytes from 'pretty-bytes';
import { throttle } from 'throttle-debounce';
import * as log from '../utils/log';
import globby from 'globby';
import mustache from 'mustache';
import open from 'open';

const pipeline = promisify(stream.pipeline);

(async () => {
  // Define log path and filename.
  const date = new Date();

  date.setDate(date.getDate() - 1);

  const month = date.getMonth() + 1;
  const day = ('00' + date.getDate()).slice(-2);
  const year = date.getFullYear().toString().slice(-2);
  const yesterday = `${month}-${day}-${year}`;
  const tmpDir = path.join(__dirname, '../../.tmp/cdn/stats');
  const filename = `${yesterday}.log`;
  const logFilePath = path.join(tmpDir, filename);
  const statsFilePath = path.join(tmpDir, `${yesterday}.html`);

  // Remove old log files
  const removeSpinner = ora({
    prefixText: 'Remove old log files.',
  }).start();

  let oldFiles = await globby(`*`, {
    cwd: tmpDir,
    ignore: [filename],
  });

  for (let i = 0; i < oldFiles.length; i++) {
    let oldFile = oldFiles[i];

    removeSpinner.text = oldFile;

    await fs.remove(path.join(tmpDir, oldFile));
  }

  removeSpinner.stop();

  // Download log file
  if (false === (await fs.pathExists(logFilePath))) {
    const downloadSpinner = ora({
      prefixText: 'Downloading log file. This may take a while.',
    }).start();

    const updateDownloadSpinner = throttle(1000, (progress: any) => {
      downloadSpinner.text = prettyBytes(progress.transferred);
    });

    await fs.ensureFile(logFilePath);

    await pipeline(
      got
        .stream(
          `https://logging.bunnycdn.com/${yesterday}/${process.env.BUNNYCDN_PULL_ZONE_ID}.log?download=true&status=100,200,400,500`,
          {
            headers: {
              AccessKey: process.env.BUNNYCDN_API_KEY,
            },
          }
        )
        .on('downloadProgress', (progress) => {
          updateDownloadSpinner(progress);
        }),
      fs.createWriteStream(logFilePath)
    );

    downloadSpinner.stop();
  }

  // Collect referrers
  let referrers: Record<
    string,
    {
      error: number;
      hit: number;
      miss: number;
    }
  > = {};

  const linesSpinner = ora({
    prefixText: 'Read log lines. This may take a while.',
  }).start();

  const updateLinesSpinner = throttle(1000, (no: number) => {
    linesSpinner.text = `${no.toLocaleString()} lines processed`;
  });

  await log.processLineByLine(logFilePath, (line, i) => {
    updateLinesSpinner(i);

    let cols = line.split('|');
    let referrer = '-';
    let isHit = cols[0] === 'HIT';
    let statusCode = parseInt(cols[1]);
    let isError = statusCode >= 400;
    let isApi = !!cols[7].match(/\d+\.\d+\/(v2|api)/);

    if (false === isApi) {
      return;
    }

    if (cols[6] !== '-') {
      referrer = cols[6].replace(/[^:]+:\/\/([^\/]+).*/, '$1');
    }

    referrers[referrer] = referrers[referrer] || {
      error: 0,
      hit: 0,
      miss: 0,
    };

    if (isError) {
      referrers[referrer].error++;
    }

    if (isHit) {
      referrers[referrer].hit++;
    } else {
      referrers[referrer].miss++;
    }
  });

  linesSpinner.stop();

  // Compile stats html
  const compileLoader = ora('Compiling stats').start();
  let tableData = [];

  for (var referrer in referrers) {
    if (referrers.hasOwnProperty(referrer)) {
      const { error, hit, miss } = referrers[referrer];
      const requests = hit + miss;

      tableData.push([
        referrer,
        requests.toLocaleString(),
        error.toLocaleString(),
        `${(error ? (error / requests) * 100 : 0).toFixed(2)}%`,
        hit.toLocaleString(),
        `${(hit ? (hit / requests) * 100 : 0).toFixed(2)}%`,
        miss.toLocaleString(),
        `${(miss ? (miss / requests) * 100 : 0).toFixed(2)}%`,
        `$ ${((5 / 10000000) * miss * 30).toFixed(2)}`,
      ]);
    }
  }

  let template = await fs.readFile(path.join(__dirname, '../../views/cdn/stats.mustache'), { encoding: 'utf-8' });

  await fs.writeFile(statsFilePath, mustache.render(template, { tableData: JSON.stringify(tableData) }));

  open(statsFilePath);

  compileLoader.stop();
})();