import net from "net";

import { HAP, API } from "homebridge";
import * as Modbus from "jsmodbus";
import {
  AccessoryConfig,
  AccessoryPlugin,
  CharacteristicEventTypes,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  Logging,
  Service,
} from "homebridge";

import { HoldingRegister, InputRegister, StatusBit } from "./registers";

type DeviceState = {
  currentIndoorTemperature: number;
  targetIndoorTemperature: number;
  currentTUVTemperature: number;
  targetTUVTemperature: number;
  status: number;
  currAirTemperature: number;
};

const INPUT_REGISTERS_COUNT = 24;

export default class AcondThermPlugin implements AccessoryPlugin {
  private readonly log: Logging;
  private readonly hap: HAP;

  // state
  private currentHeatingTemperature = 0;
  private targetHeatingTemperature = 0;
  private currentTUVTemperature = 0;
  private targetTUVTemperature = 0;
  private currentAirTemperature = 0;
  private currentDeviceStatus = 0;
  private pollingTimer;
  private isOffline = false;
  private isHeating = false;
  private isTUVHeating = false;

  // config
  private readonly name: string;
  private readonly sensorName: string;
  private readonly minHeatingTemperature: number = 10;
  private readonly maxHeatingTemperature: number = 30;
  private readonly minTUVTemperature: number = 10;
  private readonly maxTUVTemperature: number = 55;
  private readonly deviceIPAddress: string = "";
  private readonly pollingInterval: number = 20;

  // services
  private heatingThermostatService: Service;
  private TUVThermostatService: Service;
  private airTemperatureService: Service;
  private informationService: Service;
  private servicesArray: Array<Service>;

  private client: Modbus.ModbusTCPClient | null = null;
  private socket: net.Socket | null = null;

  // ctor
  constructor(log: Logging, config: AccessoryConfig, api: API) {
    log.debug("AcondTherm constructing!");

    this.log = log;
    this.hap = api.hap;
    this.name = config.name;

    // Config values
    this.sensorName = config.sensorName as string;
    this.deviceIPAddress = config.deviceIPAddress as string;
    this.pollingInterval =
      (config.pollingInterval as number) ?? this.pollingInterval;
    this.minHeatingTemperature =
      (config.minHeatingTemperature as number) ?? this.minHeatingTemperature;
    this.maxHeatingTemperature =
      (config.maxHeatingTemperature as number) ?? this.maxHeatingTemperature;
    this.minTUVTemperature =
      (config.minTUVTemperature as number) ?? this.minTUVTemperature;
    this.maxTUVTemperature =
      (config.maxTUVTemperature as number) ?? this.maxTUVTemperature;

    // init state values
    this.targetHeatingTemperature = this.minHeatingTemperature;

    // create services
    this.heatingThermostatService = new this.hap.Service.Thermostat(
      this.name + " - topení",
    );
    this.TUVThermostatService = new this.hap.Service.Thermostat(
      this.name + " - TUV",
      "TUV",
    );
    this.airTemperatureService = new this.hap.Service.TemperatureSensor(
      this.name,
    );
    this.informationService = new this.hap.Service.AccessoryInformation();
    this.servicesArray = [];
  }

  getClient(): Promise<Modbus.ModbusTCPClient> {
    return new Promise((resolve, reject) => {
      if (this.client) {
        resolve(this.client);
        return;
      }

      this.socket = new net.Socket();
      this.client = new Modbus.client.TCP(this.socket);

      const options = {
        host: this.deviceIPAddress,
        port: 502,
      };

      this.socket
        .on("connect", async () => {
          this.log.debug("Connected to device.");
          this.isOffline = false;

          resolve(this.client!);
        })
        .on("error", (err) => {
          if (!this.isOffline) {
            this.log.debug("Device offline? " + err);
            this.isOffline = true;
          }
          reject(err);
        })
        .connect(options);
    });
  }

  /*
   * This method is optional to implement. It is called when HomeKit ask to identify the accessory.
   * Typical this only ever happens at the pairing process.
   */
  identify(): void {
    this.log("AcondTherm thermostat");
  }

  configureHeatingThermostatService() {
    this.heatingThermostatService
      .getCharacteristic(this.hap.Characteristic.CurrentTemperature)
      .on(
        CharacteristicEventTypes.GET,
        (callback: CharacteristicGetCallback) => {
          this.log.info(
            "Get current heating temperature: " +
              this.currentHeatingTemperature,
          );
          callback(undefined, this.currentHeatingTemperature);
        },
      );

    this.heatingThermostatService
      .getCharacteristic(this.hap.Characteristic.TargetTemperature)
      .on(
        CharacteristicEventTypes.GET,
        (callback: CharacteristicGetCallback) => {
          this.log.info(
            "Get target heating temperature: " + this.targetHeatingTemperature,
          );
          callback(undefined, this.targetHeatingTemperature);
        },
      )
      .on(
        CharacteristicEventTypes.SET,
        (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
          this.setTargetIndoorTemperature(value as number);
          this.log.info("Set target heating temperature to: " + value);
          this.pollDeviceStatus();
          callback();
        },
      )
      .setProps({
        minValue: this.minHeatingTemperature,
        maxValue: this.maxHeatingTemperature,
      });

    this.heatingThermostatService
      .getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState)
      .on(
        CharacteristicEventTypes.GET,
        (callback: CharacteristicGetCallback) => {
          callback(
            undefined,
            this.hap.Characteristic.TargetHeatingCoolingState.AUTO,
          );
        },
      )
      .on(
        CharacteristicEventTypes.SET,
        (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
          callback();
        },
      )
      .setProps({
        validValues: [3],
      });

    this.heatingThermostatService
      .getCharacteristic(this.hap.Characteristic.CurrentHeatingCoolingState)
      .on(
        CharacteristicEventTypes.GET,
        (callback: CharacteristicGetCallback) => {
          callback(
            undefined,
            this.isHeating
              ? this.hap.Characteristic.CurrentHeatingCoolingState.HEAT
              : this.hap.Characteristic.CurrentHeatingCoolingState.OFF,
          );
        },
      );
  }

  configureTUVThermostatService() {
    this.TUVThermostatService.getCharacteristic(
      this.hap.Characteristic.CurrentTemperature,
    ).on(
      CharacteristicEventTypes.GET,
      (callback: CharacteristicGetCallback) => {
        this.log.info(
          "Get current TUV temperature: " + this.currentTUVTemperature,
        );
        callback(undefined, this.currentTUVTemperature);
      },
    );

    this.TUVThermostatService.getCharacteristic(
      this.hap.Characteristic.TargetTemperature,
    )
      .on(
        CharacteristicEventTypes.GET,
        (callback: CharacteristicGetCallback) => {
          this.log.info(
            "Get target TUV temperature: " + this.targetTUVTemperature,
          );
          callback(undefined, this.targetTUVTemperature);
        },
      )
      .on(
        CharacteristicEventTypes.SET,
        (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
          this.setTargetTUVTemperature(value as number);
          this.log.info("Set target TUV temperature to: " + value);
          this.pollDeviceStatus();
          callback();
        },
      )
      .setProps({
        minValue: this.minTUVTemperature,
        maxValue: this.maxTUVTemperature,
      });

    this.TUVThermostatService.getCharacteristic(
      this.hap.Characteristic.TargetHeatingCoolingState,
    )
      .on(
        CharacteristicEventTypes.GET,
        (callback: CharacteristicGetCallback) => {
          callback(
            undefined,
            this.hap.Characteristic.TargetHeatingCoolingState.AUTO,
          );
        },
      )
      .on(
        CharacteristicEventTypes.SET,
        (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
          callback();
        },
      )
      .setProps({
        validValues: [3],
      });

    this.TUVThermostatService.getCharacteristic(
      this.hap.Characteristic.CurrentHeatingCoolingState,
    ).on(
      CharacteristicEventTypes.GET,
      (callback: CharacteristicGetCallback) => {
        callback(
          undefined,
          this.isTUVHeating
            ? this.hap.Characteristic.CurrentHeatingCoolingState.HEAT
            : this.hap.Characteristic.CurrentHeatingCoolingState.OFF,
        );
      },
    );
  }

  configureAirTemperatureService() {
    this.airTemperatureService
      .getCharacteristic(this.hap.Characteristic.CurrentTemperature)
      .on(
        CharacteristicEventTypes.GET,
        (callback: CharacteristicGetCallback) => {
          this.log.info(
            "Get current air temperature: " + this.currentAirTemperature,
          );
          callback(undefined, this.currentAirTemperature);
        },
      );

    this.airTemperatureService
      .getCharacteristic(this.hap.Characteristic.StatusFault)
      .on(
        CharacteristicEventTypes.GET,
        (callback: CharacteristicGetCallback) => {
          callback(undefined, this.hap.Characteristic.StatusFault.NO_FAULT);
        },
      );
  }

  /*
   * This method is called directly after creation of this instance.
   * It should return all services which should be added to the accessory.
   */
  getServices(): Service[] {
    this.log.debug("AcondTherm initializing!");

    // Heating Thermostat
    this.configureHeatingThermostatService();

    // TUV Thermostat
    this.configureTUVThermostatService();

    // Air Temperature
    this.configureAirTemperatureService();

    // Information service
    this.informationService
      .setCharacteristic(this.hap.Characteristic.Manufacturer, "AcondTherm")
      .setCharacteristic(this.hap.Characteristic.Model, "Pro-N");

    // Polling service
    this.log.debug("Polling each " + this.pollingInterval + " seconds.");

    this.pollingTimer = setInterval(
      this.pollDeviceStatus.bind(this),
      this.pollingInterval * 1000,
    );

    // Get initial state
    this.pollDeviceStatus();

    this.servicesArray = [
      this.informationService,
      this.heatingThermostatService,
      this.TUVThermostatService,
      this.airTemperatureService,
    ];

    return this.servicesArray;
  }

  async setTargetIndoorTemperature(temp: number) {
    const client = await this.getClient();

    await client.writeSingleRegister(
      HoldingRegister.TargetIndoorTemperature,
      temp * 10,
    );
  }

  async setTargetTUVTemperature(temp: number) {
    const client = await this.getClient();

    await client.writeSingleRegister(
      HoldingRegister.TargetTUVTemperature,
      temp * 10,
    );
  }

  async readDeviceState(): Promise<DeviceState> {
    const client = await this.getClient();

    const { response } = await client.readInputRegisters(
      0,
      INPUT_REGISTERS_COUNT,
    );
    const { values } = response.body;

    return {
      currentIndoorTemperature:
        values[InputRegister.CurrentIndoorTemperature] / 10,
      targetIndoorTemperature:
        values[InputRegister.TargetIndoorTemperature] / 10,
      currentTUVTemperature: values[InputRegister.CurrentTUVTemperature] / 10,
      targetTUVTemperature: values[InputRegister.TargetTUVTemperature] / 10,
      status: values[InputRegister.Status],
      currAirTemperature: values[InputRegister.CurrentAirTemperature] / 10,
    };
  }

  getBit(value: number, bit: number): boolean {
    return Boolean((value >> bit) & 1);
  }

  async pollDeviceStatus(): Promise<void> {
    // device online
    this.isOffline = false;

    let state: DeviceState;

    // eslint-disable-next-line no-useless-catch
    try {
      state = await this.readDeviceState();
    } catch (ex) {
      // TODO: handle reconnection or posiibility of beign offline
      throw ex;
    }

    this.log.info("current state:", state);

    this.targetHeatingTemperature = state.targetIndoorTemperature;
    this.currentHeatingTemperature = state.currentIndoorTemperature;
    this.targetTUVTemperature = state.targetTUVTemperature;
    this.currentTUVTemperature = state.currentTUVTemperature;
    this.currentAirTemperature = state.currAirTemperature;

    const isRunning = this.getBit(state.status, StatusBit.Running);

    this.isTUVHeating = this.getBit(state.status, StatusBit.TUVHeating);

    // This is not correct, but it's the close as possible with given the status bits.
    // `isHeating` can be incorrectly set even if the device is not heating (device is preparing to heat TUV)
    this.isHeating = isRunning && !this.isTUVHeating;
    this.currentAirTemperature = state.currAirTemperature;

    this.heatingThermostatService
      .getCharacteristic(this.hap.Characteristic.CurrentHeatingCoolingState)
      .updateValue(
        this.isHeating
          ? this.hap.Characteristic.CurrentHeatingCoolingState.HEAT
          : this.hap.Characteristic.CurrentHeatingCoolingState.OFF,
      );

    this.TUVThermostatService.getCharacteristic(
      this.hap.Characteristic.CurrentHeatingCoolingState,
    ).updateValue(
      this.isTUVHeating
        ? this.hap.Characteristic.CurrentHeatingCoolingState.HEAT
        : this.hap.Characteristic.CurrentHeatingCoolingState.OFF,
    );

    this.airTemperatureService
      .getCharacteristic(this.hap.Characteristic.CurrentTemperature)
      .updateValue(this.currentAirTemperature);
  }
}
