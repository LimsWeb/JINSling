import {handleLab} from './server.mjs';

export default {
  async fetch(request,env){
    if(new URL(request.url).pathname.startsWith('/api/'))return handleLab(request,env);
    return env.ASSETS.fetch(request);
  },
};
