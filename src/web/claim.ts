/** What a page asks of the demo hospitals' worker when a hard reload left it uncontrolled. */
export const CLAIM = "cascade-demo-hospitals:claim";
/** What a page tells the worker, with a port to answer on, once it has changed the world's date in `WORLD_CACHE`. */
export const WORLD_DATE = "cascade-demo-hospitals:world-date";
/** The Cache Storage cache the page and the worker share. */
export const WORLD_CACHE = "cascade-demo-hospitals";
/** Where the world's date is kept in `WORLD_CACHE`, as a path from the worker's scope; the body is the instant, as text. */
export const WORLD_KEY = "demo-hospitals/world-date";
