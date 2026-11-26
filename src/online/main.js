// Online Builder entry point (SPEC §5). Removes Math.random after load, as
// the offline signer does, then starts the screens.
import { forbidMathRandom } from '../offline/core/lockdown.js';
import { startApp } from './ui/app.js';

const mathOk = forbidMathRandom();
document.getElementById('version').textContent = __BUILD_VERSION__;
startApp();
Object.defineProperty(window, '__icecoldOnline', { value: Object.freeze({ started: true, mathRandomDisabled: mathOk }), writable: false, configurable: false });
