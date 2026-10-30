import { handleApi } from '../../server/api.mjs';

export function onRequest(context) {
  return handleApi(context.request, context.env, context);
}
