import { API } from "homebridge";

import { PLUGIN_NAME, ACCESORY_NAME } from "./settings";
import AcondThermPlugin from "./AcondThermPlugin";

/*
 * Initializer function called when the plugin is loaded.
 */
export = (api: API) => {
  api.registerAccessory(PLUGIN_NAME, ACCESORY_NAME, AcondThermPlugin);
};
