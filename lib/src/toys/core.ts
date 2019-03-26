import { Characteristic, Peripheral } from 'noble';
// @ts-ignore
import * as Service from 'noble/lib/service';
import { factory } from '../commands';
import { factory as decodeFactory, number } from '../commands/decoder';
import {
  ICommandWithRaw,
  DeviceId,
  SensorCommandIds,
  DriveFlag
} from '../commands/types';
import { toPromise } from '../utils';
import { Queue } from './queue';
import { CharacteristicUUID, Stance, ServicesUUID } from './types';
import noble from '../noble-wrapper';

// WORKAROUND for https://github.com/Microsoft/TypeScript/issues/5711
export interface IReExport {
  a: Stance;
  b: DriveFlag;
}

// TS workaround until 2.8 (not released), then ReturnType<factory>
export const commandsType = (false as true) && factory();
export const decodeType = (false as true) && decodeFactory(_ => null);

export interface IQueuePayload {
  command: ICommandWithRaw;
  characteristic?: Characteristic;
}

export enum Event {
  onCollision = 'onCollision',
  onSensor = 'onSensor'
}

type EventMap = { [key in Event]?: (command: ICommandWithRaw) => void };

export class Core {
  protected commands: typeof commandsType;
  private peripheral: Peripheral;
  private apiV2Characteristic?: Characteristic;
  private dfuControlCharacteristic?: Characteristic;
  // private dfuInfoCharacteristic?: ICharacteristic;
  private antiDoSCharacteristic?: Characteristic;
  private decoder: typeof decodeType;
  private started: boolean;
  private queue: Queue<IQueuePayload>;
  private initPromise: Promise<void>;
  private initPromiseResolve: () => any;
  private eventsListeners: EventMap;

  constructor(p: Peripheral) {
    this.peripheral = p;
  }

  /**
   * Determines and returns the current battery charging state
   */
  public async batteryVoltage() {
    const response = await this.queueCommand(
      this.commands.power.batteryVoltage()
    );
    return number(response.command.payload, 1) / 100;
  }

  /**
   * Wakes up the toy from sleep mode
   */
  public wake() {
    return this.queueCommand(this.commands.power.wake());
  }

  /**
   * Sets the to into sleep mode
   */
  public sleep() {
    return this.queueCommand(this.commands.power.sleep());
  }

  /**
   * Starts the toy
   */
  public async start() {
    // start
    await this.init();
    await this.write(this.antiDoSCharacteristic, 'usetheforce...band');
    await toPromise(
      this.dfuControlCharacteristic.subscribe.bind(
        this.dfuControlCharacteristic
      )
    );
    await toPromise(
      this.apiV2Characteristic.subscribe.bind(this.apiV2Characteristic)
    );
    await this.initPromise;
    this.initPromiseResolve = null;
    this.started = true;

    try {
      await this.wake();
    } catch (e) {
      // tslint:disable-next-line:no-console
      console.error('error', e);
    }
  }

  /**
   * Determines and returns the system app version of the toy
   */
  public async appVersion() {
    const response = await this.queueCommand(
      this.commands.systemInfo.appVersion()
    );
    return {
      major: number(response.command.payload, 1),
      minor: number(response.command.payload, 3)
    };
  }

  public on(eventName: Event, handler: (command: ICommandWithRaw) => void) {
    this.eventsListeners[eventName] = handler;
  }

  public destroy() {
    // TODO handle all unbind, disconnect, etc
    this.eventsListeners = {}; // remove references
  }

  protected queueCommand(command: ICommandWithRaw) {
    return this.queue.queue({
      characteristic: this.apiV2Characteristic,
      command
    });
  }

  private async init() {
    const p = this.peripheral;

    this.initPromise = new Promise(async resolve => {
      this.initPromiseResolve = resolve;
    });

    this.queue = new Queue<IQueuePayload>({
      match: (cA, cB) => this.match(cA, cB),
      onExecute: item => this.onExecute(item)
    });
    this.eventsListeners = {};
    this.commands = factory();
    this.decoder = decodeFactory((error, packet) =>
      this.onPacketRead(error, packet)
    );
    this.started = false;

    await toPromise(p.connect.bind(p));

    // @ts-ignore
    noble.onServicesDiscover(
      p.uuid,
      Object.keys(ServicesUUID).map(key => ServicesUUID[key])
    );
    const charac1 = await toPromise(
      p.services[0].discoverCharacteristics.bind(p.services[0], [])
    );
    const charac2 = await toPromise(
      p.services[0].discoverCharacteristics.bind(p.services[1], [])
    );

    this.bindServices();
    this.bindListeners();
  }

  private async onExecute(item: IQueuePayload) {
    if (!this.started) {
      return;
    }

    await this.write(item.characteristic, item.command.raw);
  }

  private match(commandA: IQueuePayload, commandB: IQueuePayload) {
    return (
      commandA.command.deviceId === commandB.command.deviceId &&
      commandA.command.commandId === commandB.command.commandId &&
      commandA.command.sequenceNumber === commandB.command.sequenceNumber
    );
  }

  private bindServices() {
    this.peripheral.services.forEach(s =>
      s.characteristics.forEach(c => {
        if (c.uuid === CharacteristicUUID.antiDoSCharacteristic) {
          this.antiDoSCharacteristic = c;
        } else if (c.uuid === CharacteristicUUID.apiV2Characteristic) {
          this.apiV2Characteristic = c;
        } else if (c.uuid === CharacteristicUUID.dfuControlCharacteristic) {
          this.dfuControlCharacteristic = c;
        }
        // else if (c.uuid === CharacteristicUUID.dfuInfoCharacteristic) {
        //   this.dfuInfoCharacteristic = c;
        // }
      })
    );
  }

  private bindListeners() {
    this.apiV2Characteristic.on(
      'read',
      (data: Buffer, isNotification: boolean) =>
        this.onApiRead(data, isNotification)
    );
    this.apiV2Characteristic.on(
      'notify',
      (data: Buffer, isNotification: boolean) =>
        this.onApiNotify(data, isNotification)
    );
    this.dfuControlCharacteristic.on(
      'notify',
      (data: Buffer, isNotification: boolean) =>
        this.onDFUControlNotify(data, isNotification)
    );
  }

  private onPacketRead(error: string, command: ICommandWithRaw) {
    if (error) {
      // tslint:disable-next-line:no-console
      console.error('There was a parse error', error);
    } else if (command.sequenceNumber === 255) {
      this.eventHandler(command);
    } else {
      this.queue.onCommandProcessed({ command });
    }
  }

  private eventHandler(command: ICommandWithRaw) {
    if (
      command.deviceId === DeviceId.sensor &&
      command.commandId === SensorCommandIds.collisionDetectedAsync
    ) {
      this.handleCollision(command);
    } else if (
      command.deviceId === DeviceId.sensor &&
      command.commandId === SensorCommandIds.sensorResponse
    ) {
      this.handleSensorUpdate(command);
    } else {
      // tslint:disable-next-line:no-console
      console.log('UNKOWN EVENT', command.raw);
    }
  }

  private handleCollision(command: ICommandWithRaw) {
    // TODO parse collision
    const handler = this.eventsListeners.onCollision;
    if (handler) {
      handler(command);
    } else {
      // tslint:disable-next-line:no-console
      console.log('No handler for collision but collision was detected');
    }
  }

  private handleSensorUpdate(command: ICommandWithRaw) {
    // TODO parse sensor
    const handler = this.eventsListeners.onSensor;
    if (handler) {
      handler(command);
    } else {
      // tslint:disable-next-line:no-console
      console.log('No handler for collision but collision was detected');
    }
  }

  private onApiRead(data: Buffer, isNotification: boolean) {
    data.forEach(byte => this.decoder.add(byte));
  }

  private onApiNotify(data: any, isNotification: any) {
    if (this.initPromiseResolve) {
      this.initPromiseResolve();
      this.initPromiseResolve = null;
      this.initPromise = null;
      return;
    }
  }

  private onDFUControlNotify(data: any, isNotification: any) {
    return this.write(this.dfuControlCharacteristic, new Uint8Array([0x30]));
  }

  private write(c: Characteristic, data: Uint8Array | string) {
    let buff;
    if (typeof data === 'string') {
      buff = Buffer.from(data);
    } else {
      buff = Buffer.from(data);
    }
    return toPromise(c.write.bind(c, buff, true));
  }
}
