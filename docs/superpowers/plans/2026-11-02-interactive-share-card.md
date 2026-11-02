# One visual card with a usable address and QR

## User intent

The recipient should see one cohesive invitation card. Its upper address must be real selectable/clickable text, with the QR below for people who prefer scanning. A separate hyperlink outside an otherwise flattened PNG did not satisfy that request.

## Approach

Use a reusable HTML card with a real address anchor and QR-only canvas. It shares the existing exact-URL validation/encoding and clipboard fallbacks, contains no external QR requests, and preserves invitation fragments. Integrate it into both public and one-time invitation dialogs without duplicating the address outside the card. The password reset dialog retains its existing private link controls.

Add a public static `/share.html` page showing the same card and linking to the same origin's booking entry. It has a normal root link even if JavaScript fails and does not request member data. Owner controls can open/copy this card page. Retain PNG as a print/photo option, with clear copy that photographs do not preserve interactive links.

Separately deliver a square PDF for the current production URL. Its address is actual text with a PDF link annotation and its QR is generated from that same URL. This file is immediately usable without a site update and should be sent as a document, not converted to a photo. No database or authentication behavior changes.

## Verification and delivery

- Reproduce that the old preview has no actual address inside a unified card.
- Verify exact address/fragment, selectable text, link opening, clipboard fallback, one continuous layout, mobile fit, safe text rendering and no external requests in Chromium.
- Verify public card page without a login/API dependency and its ordinary-link fallback.
- Check PDF URL extraction and link annotation, render the page and visually inspect it.
- Run the existing unit suite, syntax/build checks and a focused independent review; build the updated Pages ZIP and preserve remote GitHub changes.
