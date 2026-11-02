import {createInteractiveShareCard} from './share-card-view.mjs';

// Public by design: no session or member API is needed to open this card.
// Keep the ordinary HTML link available if the module or QR renderer fails.
const container=document.querySelector('#share-card-root');
if(container){
  try{
    const url=new URL('/',window.location.href).href;
    const card=createInteractiveShareCard({url,kind:'public',shopName:'jinSling 예약'});
    container.replaceChildren(card);
  }catch{
    container.dataset.cardFallback='true';
  }
}
