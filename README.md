Sky+ plugin for Homebridge
===

Homebridge plugin for controlling a Sky+ box as a TV. This works best if the Sky+ box is the only device connected to
the TV and (as it doesn't tell the TV to turn off when it turns itself off) the TV is set to turn itself off when
nothing is connected.

This plugin only supports the iOS 12.2 Television service.

```json
{
    "accessory": "sky-tv.TV",
    "name": "TV",
    "ip_address": "192.168.3.252",
    "tv_channels": {
        ...
    }
}
```

### Configuration

The configuration format is mostly the same as https://gitlab.fancy.org.uk/samuel/homebridge-vestel-network-remote,
except only the `ip_address` and `tv_channels` properties are supported, and the `tv_channels` property is an object
mapping internal channel IDs to display names.

```json
{
    "accessory": "sky-tv.TV",
    "name": "TV",
    "ip_address": "192.168.3.252",
    "tv_channels": {
        "2076": "BBC One HD",
        "2075": "BBC Two HD",
        "6381": "ITV HD",
        "2075": "Channel 4 HD",
        "4058": "Channel 5 HD",
        ...
    }
}
```

The plugin will output the ID of the current channel whenever the channel changes, so to find the internal channel IDs
you can just watch the console output as you switch to a channel.

Once the plugin has connected to the Sky+ box it will update the manufacturer, model, serial number and firmware
revision characteristics.

[Read this if you have multiple TVs on a single Homebridge server. (Use the `sky-tv.TVs` platform instead of `vestel-network-remote.TVs`.)](https://gitlab.fancy.org.uk/samuel/homebridge-vestel-network-remote#multiple-tvs)

### Limitations

Sky+ has limited HDMI CEC support (you can only turn the TV on and use the TV's remote to control the Sky box). It is
not possible to change the TV's volume or turn the TV off. With most TVs you can work around not being able to turn
the TV off by setting it to turn off when nothing is connected. Sky+ also doesn't support turning off when the TV
turns off, so HomeKit may still say the TV is on when only the Sky+ box is on.
