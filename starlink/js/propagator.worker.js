// Web worker wrapper around the SGP4 propagator.
import { createPropagator } from './propagator.js';

const propagator = createPropagator((msg, transfer) => self.postMessage(msg, transfer || []));
self.onmessage = ({ data }) => propagator.handle(data);
