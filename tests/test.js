const path = require('path');
const storage = require('node-persist');
const hap = require('hap-nodejs');
const {Accessory, Service, Characteristic, uuid} = hap;

const accessory_config = {
    // port: 51826,
    username: 'A3:FB:3D:4D:2E:AD',
    pincode: '031-45-154',
    category: Accessory.Categories.TELEVISION,
};

const config = require(process.argv[2] || './config');

const homebridge_config = {
    bridge: accessory_config,
    accessories: [config],
};

const homebridge_plugin = require('..');
const accessory_types = {};

const log = function (...args) {
    console.log(...args);
};
Object.setPrototypeOf(log, console);

homebridge_plugin({
    hap,
    user: {
        config: () => homebridge_config,
        storagePath: () => path.resolve(__dirname, '..'),
        configPath: () => path.resolve(__dirname, 'config.json'),
        persistPath: () => path.resolve(__dirname, '..', 'persist'),
        cachedAccessoryPath: () => path.resolve(__dirname, '..', 'accessories'),
    },
    registerAccessory: (package, type, accessory) => {
        accessory_types[package + '.' + type] = accessory_types[type] = accessory;
    },
    registerPlatform: (package, type, platform) => {
        // Not supported
    },
}, log);

if (!accessory_types[config.accessory]) {
    throw new Error('Unknown accessory "' + config.accessory + '"');
}

const accessory_instance = new accessory_types[config.accessory](log, config);
const services = accessory_instance.getServices();

const accessory_uuid = uuid.generate('hap-nodejs:accessories:tv');
const accessory = new Accessory('TV', accessory_uuid, Accessory.Categories.TELEVISION);

for (let service of services) {
    if (service instanceof Service.AccessoryInformation) {
        for (let characteristic of [
            'Manufacturer', 'Model', 'SerialNumber', 'FirmwareRevision', 'HardwareRevision',
        ]) {
            const {value} = service.getCharacteristic(Characteristic[characteristic]);
            if (value) accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic[characteristic], value);
        }

        continue;
    }

    accessory.addService(service);
}

if (accessory_instance.identify) {
    accessory.on('identify', (paired, callback) => accessory_instance.identify(callback));
}

storage.initSync({
    dir: path.resolve(__dirname, '..', 'persist'),
    stringify: data => JSON.stringify(data, undefined, 4) + '\n',
});

// Publish this Accessory on the local network
accessory.publish(accessory_config);

console.log('Listening on port', accessory_config.port);
console.log('Setup code is', accessory_config.pincode);

for (let [signal, id] of Object.entries({SIGINT: 2, SIGTERM: 15})) {
    process.on(signal, () => {
        console.log('Shutting down');
        accessory.unpublish();
        setTimeout(() => process.exit(128 + id), 1000);
    });
}
