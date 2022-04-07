export enum HoldingRegister {
  TargetIndoorTemperature = 0,
  TargetTUVTemperature = 4,
}

export enum InputRegister {
  TargetIndoorTemperature = 0,
  CurrentIndoorTemperature = 1,
  TargetTUVTemperature = 4,
  CurrentTUVTemperature = 5,
  Status = 6,
  CurrentAirTemperature = 9,
}

export enum StatusBit {
  On = 0,
  Running = 1,
  Failure = 2,
  TUVHeating = 3,
}
