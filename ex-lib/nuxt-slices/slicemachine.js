import request from 'request';
import tmp from 'tmp';
import fs from 'fs';
import Communication from '../communication';

const SliceMachine = {
  /**
   * should get all slices (keys + definitions) and match their
   */
  async fetchAllSlicesModels(endpoint, cookies) {
    return JSON.parse(await Communication.get(endpoint, cookies));
  },

  /* returns the path of the zip file or an Error */
  downloadSlices: async (endpoint, params) => {
    const url = new URL(endpoint);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

    const tmpZipFile = tmp.tmpNameSync();
    return new Promise((resolve, reject) => {
      request(url.href)
        .on('response', (response) => {
          response.pipe(fs.createWriteStream(tmpZipFile))
            .on('error', ({ message }) => reject(message))
            .on('finish', () => resolve(tmpZipFile));
        })
        .on('error', reject);
    });
  },
};

export default SliceMachine;
