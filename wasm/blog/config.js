// Where the published posts live (the folder holding index.json and posts/).
//
// The default './' works when the site is uploaded to the same bucket or
// folder as the posts (scripts/publish.mjs --site). To read posts from a
// different origin, such as an R2 public URL, put that URL here, add it to
// connect-src in index.html's Content-Security-Policy, and allow GET from
// the site's origin in the bucket's CORS settings.
export const STORAGE_URL = './';
