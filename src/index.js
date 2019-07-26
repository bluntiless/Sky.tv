
const persist = require('node-persist');
const SkyPlus = require('sky-plus-hd');
const SkyRemote = require('sky-remote');

const key_map = {};

module.exports = function (homebridge) {
    const storage = persist.create();

    storage.initSync({
        dir: homebridge.user.persistPath(),
        stringify: data => JSON.stringify(data, undefined, 4) + '\n',
    });

    const BoundTVAccessory = TVAccessory.use(homebridge, homebridge.hap, storage);
    homebridge.registerAccessory('sky-tv', 'TV', BoundTVAccessory);
    homebridge.registerPlatform('sky-tv', 'TVs', TVPlatform.use(BoundTVAccessory, homebridge, homebridge.hap, storage));

    Object.assign(key_map, {
        [homebridge.hap.Characteristic.RemoteKey.REWIND]: 'rewind',
        [homebridge.hap.Characteristic.RemoteKey.FAST_FORWARD]: 'fastforward',
        // [homebridge.hap.Characteristic.RemoteKey.NEXT_TRACK]:
        // [homebridge.hap.Characteristic.RemoteKey.PREVIOUS_TRACK]:
        [homebridge.hap.Characteristic.RemoteKey.ARROW_UP]: 'up',
        [homebridge.hap.Characteristic.RemoteKey.ARROW_DOWN]: 'down',
        [homebridge.hap.Characteristic.RemoteKey.ARROW_LEFT]: 'left',
        [homebridge.hap.Characteristic.RemoteKey.ARROW_RIGHT]: 'right',
        [homebridge.hap.Characteristic.RemoteKey.SELECT]: 'select',
        [homebridge.hap.Characteristic.RemoteKey.BACK]: 'backup',
        // [homebridge.hap.Characteristic.RemoteKey.EXIT]: 'home',
        [homebridge.hap.Characteristic.RemoteKey.PLAY_PAUSE]: 'play', // ???
        [homebridge.hap.Characteristic.RemoteKey.INFORMATION]: 'i',
    });
};

class TVPlatform {
    static use(TVAccessory, homebridge, hap, storage) {
        return class extends this {
            static get TVAccessory() {
                return TVAccessory;
            }

            static get homebridge_api() {
                return homebridge;
            }

            static get hap() {
                return hap;
            }

            static get storage() {
                return storage;
            }
        };
    }

    constructor(log, config, homebridge) {
        this.log = log;
        this.config = config;

        if (this.constructor.homebridge_api !== homebridge) {
            throw new Error('Different homebridge API???');
        }

        this.tvs = config.tvs || [];
        this.external = config.external !== undefined ? !!config.external : false;
    }

    accessories(callback) {
        this.getAccessories().then(accessories => callback(accessories)).catch(err => {
            this.log.error('Failed to load platform accessories', err);
            callback([]);
        });
    }

    /**
     * Get accessories to publish on the bridge and publish any external accessories.
     *
     * @return {Promise<this.constructor.homebridge_api.PlatformAccessory[]>}
     */
    async getAccessories() {
        this.getAccessories = () => {
            throw new Error('getAccessories can only be called once');
        };

        const accessories = [];
        const external_accessories = [];

        for (const config of this.tvs) {
            const accessory = new this.constructor.TVAccessory(this.log, config, this);
            const platform_accessory = this.createPlatformAccessory(accessory);

            const external = this.external || (config.external !== undefined ? !!config.external : true);

            if (!this.constructor.TVAccessory.instances) this.constructor.TVAccessory.instances = [];

            if (this.constructor.TVAccessory.instances.length) {
                this.log.warn('You have multiple TV accessories published on the same bridge. The iOS TV Remote ' +
                    'only allows one Television service per HAP server. You should set the external flag on at ' +
                    'least all but one to true or remove it.');
            }

            this.constructor.TVAccessory.instances.push(accessory);

            external ? external_accessories.push(platform_accessory) : accessories.push(platform_accessory);
        }

        for (const platform_accessory of external_accessories) {
            this.constructor.homebridge_api.publishExternalAccessories(platform_accessory);
        }

        return accessories;
    }

    /**
     * Creates a PlatformAccessory from a TVAccessory.
     *
     * @param {TVAccessory} accessory
     * @return {PlatformAccessory}
     */
    createPlatformAccessory(accessory) {
        const platform_accessory = new this.constructor.homebridge_api.platformAccessory(
            accessory.name,
            this.constructor.hap.uuid.generate('sky-tv.TV:' + accessory.name),
            this.constructor.hap.Accessory.Categories.TELEVISION
        );

        const services = accessory.getServices();

        for (const service of services) {
            if (service instanceof this.constructor.hap.Service.AccessoryInformation) {
                for (const characteristic of [
                    'Manufacturer', 'Model', 'SerialNumber', 'FirmwareRevision', 'HardwareRevision',
                ]) {
                    const {value} = service.getCharacteristic(this.constructor.hap.Characteristic[characteristic]);
                    if (!value) continue;
                    platform_accessory.getService(this.constructor.hap.Service.AccessoryInformation)
                        .setCharacteristic(this.constructor.hap.Characteristic[characteristic], value);
                }

                continue;
            }

            platform_accessory.addService(service);
        }

        return platform_accessory;
    }
}

class TVAccessory {
    static use(homebridge, hap, storage) {
        return class extends this {
            static get homebridge_api() {
                return homebridge;
            }

            static get hap() {
                return hap;
            }

            static get storage() {
                return storage;
            }
        };
    }

    constructor(log, config, platform_instance) {
        this.platform_instance = platform_instance;
        this.log = log;
        this.name = config.name;
        this.ip_address = config.ip_address;

        this.storage_key = 'sky-tv.TV.' + this.name + '.json';

        if (!this.constructor.instances) this.constructor.instances = [];

        if (this.constructor.instances.find(a => !a.platform_instance)) {
            this.log.warn('You have multiple TV accessories published on the same bridge. The iOS TV Remote only ' +
                'allows one Television service per HAP server. You should move at least all but one TV accessory to ' +
                'the sky-tv.TVs platform.');
        }

        this.constructor.instances.push(this);

        // Connect to the TV
        this.remote = new SkyRemote(this.ip_address);

        this.channel_id = null;

        const tryConnect = () => this.tryConnect().catch(err => {
            this.log.error('Failed to connect to Sky box, will retry in 30s');
            return new Promise(rs => setTimeout(rs, 30000)).then(tryConnect);
        });

        tryConnect();

        // Add Input Source services
        this.tv_sources = [];

        this.home_screen_service = this.addInputSourceService('Home', {
            name: 'Home',
            input_source_type: 'HDMI',
            input_device_type: 'OTHER',
            remote_key: 'home',
            always_enabled: true,
        });

        const tv_channel_input_source_services = [];

        for (const [channel_number, name] of Object.entries(config.tv_channels || {})) {
            tv_channel_input_source_services.push(this.addChannelInputSourceService(channel_number, name));
        }

        this.accessory_information_service = new this.constructor.hap.Service.AccessoryInformation();
        this.accessory_information_service
            .setCharacteristic(this.constructor.hap.Characteristic.Manufacturer, config.manufacturer || 'Samuel Elliott')
            .setCharacteristic(this.constructor.hap.Characteristic.Model, config.model || 'https://gitlab.fancy.org.uk/samuel/homebridge-sky-tv')
            .setCharacteristic(this.constructor.hap.Characteristic.SerialNumber, config.serial_number || this.ip_address)
            .setCharacteristic(this.constructor.hap.Characteristic.FirmwareRevision, require('../package').version);

        const cached_accessory_information = this.getItemSync('CachedAccessoryInformation');

        if (cached_accessory_information) {
            this.accessory_information_service
                .setCharacteristic(this.constructor.hap.Characteristic.Manufacturer, cached_accessory_information.manufacturer)
                .setCharacteristic(this.constructor.hap.Characteristic.Model, cached_accessory_information.model)
                .setCharacteristic(this.constructor.hap.Characteristic.SerialNumber, cached_accessory_information.serial_number)
                .setCharacteristic(this.constructor.hap.Characteristic.FirmwareRevision, cached_accessory_information.firmware_revision);
        }
    }

    async tryConnect() {
        const sky = await SkyPlus.findBox(this.ip_address, {
            ip: this.ip_address,
            // region: this.region,
        });

        this.sky = sky;

        sky.on('change', async state => {
            if (!this.channel_id) this.log('Channel ID %s', state.uri_id);
            else if (this.channel_id !== state.uri_id) this.log('Channel ID %s (was %s)', state.uri_id, this.channel_id);
            this.channel_id = state.uri_id;

            this.tv_service.getCharacteristic(this.constructor.hap.Characteristic.Active).updateValue(!state.standbyState ?
                this.constructor.hap.Characteristic.Active.ACTIVE :
                this.constructor.hap.Characteristic.Active.INACTIVE);

            this.tv_service.getCharacteristic(this.constructor.hap.Characteristic.ActiveIdentifier).updateValue(await this.getInputIdentifier());
        });

        this.log('Connected to Sky box %s at %s', sky.serial, this.ip_address);

        await this.setItem('CachedAccessoryInformation', {
            manufacturer: 'Sky',
            model: sky.model,
            serial_number: sky.serial,
            firmware_revision: sky.software,
        });

        this.accessory_information_service
            .setCharacteristic(this.constructor.hap.Characteristic.Manufacturer, 'Sky')
            .setCharacteristic(this.constructor.hap.Characteristic.Model, sky.model)
            .setCharacteristic(this.constructor.hap.Characteristic.SerialNumber, sky.serial)
            .setCharacteristic(this.constructor.hap.Characteristic.FirmwareRevision, sky.software);
    }

    async identify(callback) {
        this.log('Identify called');
        await this.sendRemoteKeypress('i');
        callback();
    }

    getServices() {
        const services = [this.accessory_information_service];

        services.push(this.tv_service, ...this.input_source_services);
        // services.push(this.tv_speaker_service);

        return services;
    }

    //
    // Storage
    //

    async getItem(key) {
        if (!this.storage_cache) {
            this.storage_cache = await this.constructor.storage.getItem(this.storage_key) || {};
        }

        return this.storage_cache[key];
    }

    getItemSync(key) {
        if (!this.storage_cache) {
            this.storage_cache = this.constructor.storage.getItemSync(this.storage_key) || {};
        }

        return this.storage_cache[key];
    }

    async setItem(key, value) {
        if (!this.storage_cache) {
            this.storage_cache = await this.constructor.storage.getItem(this.storage_key) || {};
        }

        this.storage_cache[key] = value;

        await this.constructor.storage.setItem(this.storage_key, this.storage_cache);
    }

    //
    // Power
    //

    async getPowerState(timeout) {
        if (!this.sky) throw new Error('SERVICE_COMMUNICATION_ERROR');

        this.log.debug('Getting power state of ' + this.name);

        return this.sky.checkPowerState();
    }

    async setPowerState(on) {
        return this['setPowerStateO' + (on ? 'n' : 'ff')]();
    }

    async setPowerStateOn() {
        if (await this.getPowerState()) return;

        this.log('Turning ' + this.name + ' on');
		await this.sendRemoteKeypress('power');
    }

    async setPowerStateOff() {
        if (!await this.getPowerState()) return;

        this.log('Turning ' + this.name + ' off');
		await this.sendRemoteKeypress('power');
    }

    //
    // Television service
    //

    get tv_service() {
        const tv_service = new this.constructor.hap.Service.Television(this.name);

        tv_service.getCharacteristic(this.constructor.hap.Characteristic.Active)
            .on('get', callback => this.getPowerState().then(data => callback(undefined, data ?
                this.constructor.hap.Characteristic.Active.ACTIVE :
                this.constructor.hap.Characteristic.Active.INACTIVE)).catch(callback))
            .on('set', (on, callback) => this.setPowerState(on === this.constructor.hap.Characteristic.Active.ACTIVE ?
                true : false).then(data => {
                    if (this.expose_power_service) {
                        this.power_service.getCharacteristic(this.constructor.hap.Characteristic.On)
                            .updateValue(on === this.constructor.hap.Characteristic.Active.ACTIVE);
                    }
                    callback(undefined, data);
                }).catch(callback))
            .on('subscribe', () => this.log.debug('Subscribed to Television/Active characteristic'))
            .on('unsubscribe', () => this.log.debug('Unsubscribed from Television/Active characteristic'));

        tv_service.getCharacteristic(this.constructor.hap.Characteristic.ActiveIdentifier)
            .on('get', callback => this.getInputIdentifier().then(data => callback(undefined, data)).catch(callback))
            .on('set', (input, callback) => this.setInputIdentifier(input).then(data => callback(undefined, data)).catch(callback));

        tv_service.getCharacteristic(this.constructor.hap.Characteristic.ConfiguredName)
            .on('get', callback => this.getConfiguredName().then(data => callback(undefined, data)).catch(callback))
            .on('set', (name, callback) => this.setConfiguredName(name).then(data => callback(undefined, data)).catch(callback))
            .updateValue(this.getConfiguredNameSync());

        tv_service.setCharacteristic(this.constructor.hap.Characteristic.SleepDiscoveryMode,
            this.constructor.hap.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
        tv_service.getCharacteristic(this.constructor.hap.Characteristic.RemoteKey)
            .on('set', (key, callback) => this.sendRemoteKey(key).then(data => callback(undefined, data)).catch(callback));

        return Object.defineProperty(this, 'tv_service', {configurable: true, value: tv_service}).tv_service;
    }

    async getInputIdentifier() {
        if (!this.sky) throw new Error('SERVICE_COMMUNICATION_ERROR');

        const service = this.input_source_services.find(s => s.config.channel_number == this.channel_id);

        if (service) console.log('Current channel service', service.config.channel_number, service.config.name);

        if (!service) return this.home_screen_service.getCharacteristic(this.constructor.hap.Characteristic.Identifier).value;
        return service.getCharacteristic(this.constructor.hap.Characteristic.Identifier).value;
    }

    async setInputIdentifier(identifier) {
        if (!this.input_source_services[identifier]) {
            this.log('Unknown input identifier ' + identifier + ' for ' + this.name);
            return;
        }

        const service = this.input_source_services[identifier];

        this.log('Setting input identifier for ' + this.name + ' to ' + identifier + ' (' +
            (await this.getInputSourceName(identifier) || service.displayName) + ')');

        try {
            if (service.config.channel_number) {
                const channel_uri = `xsi://${parseInt(service.config.channel_number).toString(16).toUpperCase()}`;
                this.log('Setting uri', channel_uri);

                try {
            		await this.sky.setURI(channel_uri);
                } catch (err) {
                    // This can fail if the TV guide is open
                    this.log('Trying to close the TV guide');
                    await this.sendRemoteKeypress('tvguide');
                    await this.sendRemoteKeypress('backup');
                    await this.sendRemoteKeypress('backup');
                    await this.sendRemoteKeypress('backup');
                    await this.sendRemoteKeypress('backup');

                    await new Promise(rs => setTimeout(rs, 1000));

            		await this.sky.setURI(channel_uri);
                }
            } else if (service.config.remote_key) {
                // Send a keypress to the TV
                await this.sendRemoteKeypress(service.config.remote_key);
            } else {
                this.log('Unsupported source');
                throw new Error('Unsupported source');
            }
        } catch (err) {
            this.log.error('Error setting input source', err);
            throw err;
        }
    }

    async getConfiguredName() {
        return await this.getItem('ConfiguredName');
    }

    getConfiguredNameSync() {
        return this.getItemSync('ConfiguredName');
    }

    async setConfiguredName(name) {
        this.log('Setting configured name for Television service for ' + this.name + ': ' + name);
        await this.setItem('ConfiguredName', name);
    }

    sendRemoteKeypress(key) {
        return new Promise((resolve, reject) => {
            this.remote.press(key, err => err ? reject(err) : resolve());
        });
    }

    async sendRemoteKey(key) {
        if (!key_map[key]) {
            throw new Error('Unsupported remote key');
        }

        const name = Object.keys(this.constructor.hap.Characteristic.RemoteKey)
            [Object.values(this.constructor.hap.Characteristic.RemoteKey).findIndex(value => value === key)];

        this.log('Sending key ' + key_map[key] + ' (' + name + ': ' + key + ') to ' + this.name);

        await this.remote.press(key_map[key]);
    }

    //
    // Input Source services
    //

    get input_source_services() {
        return Object.defineProperty(this, 'input_source_services', {configurable: true, value: []}).input_source_services;
    }

    addInputSourceService(id, config, type, subtype) {
        if (!type) {
            if (typeof config === 'object') type = config.input_source_type;
            if (config instanceof Array) type = config[0];
        }
        if (!subtype) {
            if (typeof config === 'object') subtype = config.input_device_type;
            if (config instanceof Array) subtype = config[1];
        }

        const identifier = typeof config.channel_number !== 'undefined' ? 'Channel.' + config.channel_number :
            type + (subtype ? '.' + subtype : '') + '.' + (config.name || id);
        const input_service = new this.constructor.hap.Service.InputSource(config.name, identifier);

        const index = this.input_source_services.length;

        this.input_source_services.push(input_service);
        this.tv_service.addLinkedService(input_service);

        if (typeof config !== 'object') config = {};
        input_service.config = config;

        input_service.setCharacteristic(this.constructor.hap.Characteristic.InputSourceType,
            typeof type === 'number' ? type : this.constructor.hap.Characteristic.InputSourceType[type]);

        if (subtype) {
            input_service.setCharacteristic(this.constructor.hap.Characteristic.InputDeviceType,
                typeof subtype === 'number' ? subtype : this.constructor.hap.Characteristic.InputDeviceType[subtype]);
        }

        input_service.getCharacteristic(this.constructor.hap.Characteristic.ConfiguredName)
            .on('get', callback => this.getInputSourceName(identifier).then(data => callback(undefined, data)).catch(callback))
            .on('set', (name, callback) => this.setInputSourceName(identifier, name).then(data => callback(undefined, data)).catch(callback))
            .updateValue(this.getInputSourceNameSync(identifier));

        input_service.setCharacteristic(this.constructor.hap.Characteristic.IsConfigured,
            this.constructor.hap.Characteristic.IsConfigured.CONFIGURED);
        input_service.setCharacteristic(this.constructor.hap.Characteristic.CurrentVisibilityState,
            config.always_enabled || this.getInputSourceEnabledSync(identifier) ?
                this.constructor.hap.Characteristic.CurrentVisibilityState.SHOWN :
                    this.constructor.hap.Characteristic.CurrentVisibilityState.HIDDEN);

        if (!config.always_enabled) {
            input_service.getCharacteristic(this.constructor.hap.Characteristic.TargetVisibilityState)
                .on('get', callback => this.getInputSourceEnabled(identifier).then(enabled => callback(null, enabled ?
                    this.constructor.hap.Characteristic.CurrentVisibilityState.SHOWN :
                    this.constructor.hap.Characteristic.CurrentVisibilityState.HIDDEN)).catch(callback))
                .on('set', (visibility_state, callback) => this.setInputSourceEnabled(identifier,
                    visibility_state === this.constructor.hap.Characteristic.TargetVisibilityState.SHOWN
                ).then(data => callback(null, data)).then(() =>
                    input_service.setCharacteristic(this.constructor.hap.Characteristic.CurrentVisibilityState, visibility_state)).catch(callback))
                .updateValue(this.getInputSourceEnabledSync(identifier) ?
                    this.constructor.hap.Characteristic.CurrentVisibilityState.SHOWN :
                    this.constructor.hap.Characteristic.CurrentVisibilityState.HIDDEN);
        }

        input_service.setCharacteristic(this.constructor.hap.Characteristic.Identifier, index);

        return input_service;
    }

    addChannelInputSourceService(channel_number, name) {
        return this.addInputSourceService(name, {
            name,
            input_source_type: 'HDMI',
            input_device_type: 'TUNER',
            channel_number,
        });
    }

    async getInputSourceName(id) {
        return await this.getItem('InputSource.' + id + '.ConfiguredName');
    }

    getInputSourceNameSync(id) {
        return this.getItemSync('InputSource.' + id + '.ConfiguredName');
    }

    async setInputSourceName(id, name) {
        this.log('Setting configured name for Input Source service "' + id + '" for ' + this.name + ': ' + name);
        await this.setItem('InputSource.' + id + '.ConfiguredName', name);
    }

    async getInputSourceEnabled(id) {
        const enabled = await this.getItem('InputSource.' + id + '.Enabled');
        return typeof enabled === 'boolean' ? enabled : true;
    }

    getInputSourceEnabledSync(id) {
        const enabled = this.getItemSync('InputSource.' + id + '.Enabled');
        return typeof enabled === 'boolean' ? enabled : true;
    }

    async setInputSourceEnabled(id, enabled) {
        this.log('Setting enabled for Input Source service "%s" for %s', id, this.name);
        await this.setItem('InputSource.' + id + '.Enabled', !!enabled);
    }
}

module.exports.TVPlatform = TVPlatform;
module.exports.TVAccessory = TVAccessory;
module.exports.key_map = key_map;
