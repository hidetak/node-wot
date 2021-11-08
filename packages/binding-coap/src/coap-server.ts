/********************************************************************************
 * Copyright (c) 2018 - 2021 Contributors to the Eclipse Foundation
 *
 * See the NOTICE file(s) distributed with this work for additional
 * information regarding copyright ownership.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0, or the W3C Software Notice and
 * Document License (2015-05-13) which is available at
 * https://www.w3.org/Consortium/Legal/2015/copyright-software-and-document.
 *
 * SPDX-License-Identifier: EPL-2.0 OR W3C-20150513
 ********************************************************************************/

/**
 * CoAP Server based on coap by mcollina
 */

import * as TD from "@node-wot/td-tools";
import Servient, { ProtocolServer, ContentSerdes, ExposedThing, Helpers, ProtocolHelpers } from "@node-wot/core";
import { Socket } from "dgram";
import { Server, createServer, registerFormat, IncomingMessage, OutgoingMessage } from "coap";
import slugify from "slugify";

export default class CoapServer implements ProtocolServer {
    public readonly scheme: string = "coap";

    private readonly PROPERTY_DIR = "properties";
    private readonly ACTION_DIR = "actions";
    private readonly EVENT_DIR = "events";

    private readonly port: number = 5683;
    private readonly address?: string = undefined;
    private readonly server: Server = createServer((req: IncomingMessage, res: OutgoingMessage) => {
        this.handleRequest(req, res);
    });

    private readonly things: Map<string, ExposedThing> = new Map<string, ExposedThing>();

    constructor(port?: number, address?: string) {
        if (port !== undefined) {
            this.port = port;
        }
        if (address !== undefined) {
            this.address = address;
        }

        // WoT-specific content formats
        registerFormat(ContentSerdes.JSON_LD, 2100);
    }

    public start(servient: Servient): Promise<void> {
        console.info(
            "[binding-coap]",
            `CoapServer starting on ${this.address !== undefined ? this.address + " " : ""}port ${this.port}`
        );
        return new Promise<void>((resolve, reject) => {
            // start promise handles all errors until successful start
            this.server.once("error", (err: Error) => {
                reject(err);
            });
            this.server.listen(this.port, this.address, () => {
                // once started, console "handles" errors
                this.server.on("error", (err: Error) => {
                    console.error("[binding-coap]", `CoapServer for port ${this.port} failed: ${err.message}`);
                });
                resolve();
            });
        });
    }

    public stop(): Promise<void> {
        console.info("[binding-coap]", `CoapServer stopping on port ${this.getPort()}`);
        return new Promise<void>((resolve, reject) => {
            // stop promise handles all errors from now on
            this.server.once("error", (err: Error) => {
                reject(err);
            });
            this.server.close(() => {
                resolve();
            });
        });
    }

    /** returns socket to be re-used by CoapClients */
    public getSocket(): Socket {
        return this.server._sock;
    }

    /** returns server port number and indicates that server is running when larger than -1  */
    public getPort(): number {
        if (this.server._sock) {
            return this.server._sock.address().port;
        } else {
            return -1;
        }
    }

    public expose(thing: ExposedThing, tdTemplate?: WoT.ExposedThingInit): Promise<void> {
        let urlPath = slugify(thing.title, { lower: true });

        if (this.things.has(urlPath)) {
            urlPath = Helpers.generateUniqueName(urlPath);
        }

        console.debug(
            "[binding-coap]",
            `CoapServer on port ${this.getPort()} exposes '${thing.title}' as unique '/${urlPath}'`
        );

        if (this.getPort() !== -1) {
            this.things.set(urlPath, thing);

            // fill in binding data
            for (const address of Helpers.getAddresses()) {
                for (const type of ContentSerdes.get().getOfferedMediaTypes()) {
                    const base: string =
                        this.scheme + "://" + address + ":" + this.getPort() + "/" + encodeURIComponent(urlPath);

                    for (const propertyName in thing.properties) {
                        const href = base + "/" + this.PROPERTY_DIR + "/" + encodeURIComponent(propertyName);
                        const form = new TD.Form(href, type);
                        ProtocolHelpers.updatePropertyFormWithTemplate(form, tdTemplate, propertyName);
                        if (thing.properties[propertyName].readOnly) {
                            form.op = ["readproperty"];
                        } else if (thing.properties[propertyName].writeOnly) {
                            form.op = ["writeproperty"];
                        } else {
                            form.op = ["readproperty", "writeproperty"];
                        }
                        if (thing.properties[propertyName].observable) {
                            if (!form.op) {
                                form.op = [];
                            }
                            form.op.push("observeproperty");
                            form.op.push("unobserveproperty");
                        }

                        thing.properties[propertyName].forms.push(form);
                        console.debug(
                            "[binding-coap]",
                            `CoapServer on port ${this.getPort()} assigns '${href}' to Property '${propertyName}'`
                        );
                    }

                    for (const actionName in thing.actions) {
                        const href = base + "/" + this.ACTION_DIR + "/" + encodeURIComponent(actionName);
                        const form = new TD.Form(href, type);
                        ProtocolHelpers.updateActionFormWithTemplate(form, tdTemplate, actionName);
                        form.op = "invokeaction";
                        thing.actions[actionName].forms.push(form);
                        console.debug(
                            "[binding-coap]",
                            `CoapServer on port ${this.getPort()} assigns '${href}' to Action '${actionName}'`
                        );
                    }

                    for (const eventName in thing.events) {
                        const href = base + "/" + this.EVENT_DIR + "/" + encodeURIComponent(eventName);
                        const form = new TD.Form(href, type);
                        ProtocolHelpers.updateEventFormWithTemplate(form, tdTemplate, eventName);
                        form.op = ["subscribeevent", "unsubscribeevent"];
                        thing.events[eventName].forms.push(form);
                        console.debug(
                            "[binding-coap]",
                            `CoapServer on port ${this.getPort()} assigns '${href}' to Event '${eventName}'`
                        );
                    }
                } // media types
            } // addresses
        } // running

        return new Promise<void>((resolve, reject) => {
            resolve();
        });
    }

    public destroy(thingId: string): Promise<boolean> {
        console.debug("[binding-coap]", `CoapServer on port ${this.getPort()} destroying thingId '${thingId}'`);
        return new Promise<boolean>((resolve, reject) => {
            let removedThing: ExposedThing;
            for (const name of Array.from(this.things.keys())) {
                const expThing = this.things.get(name);
                if (expThing?.id === thingId) {
                    this.things.delete(name);
                    removedThing = expThing;
                }
            }
            if (removedThing) {
                console.info("[binding-coap]", `CoapServer succesfully destroyed '${removedThing.title}'`);
            } else {
                console.info("[binding-coap]", `CoapServer failed to destroy thing with thingId '${thingId}'`);
            }
            resolve(removedThing !== undefined);
        });
    }

    private handleRequest(req: IncomingMessage, res: OutgoingMessage) {
        console.debug(
            "[binding-coap]",
            `CoapServer on port ${this.getPort()} received '${req.method}(${req._packet.messageId}) ${
                req.url
            }' from ${Helpers.toUriLiteral(req.rsinfo.address)}:${req.rsinfo.port}`
        );
        res.on("finish", () => {
            console.debug(
                "[binding-coap]",
                `CoapServer replied with '${res.code}' to ${Helpers.toUriLiteral(req.rsinfo.address)}:${
                    req.rsinfo.port
                }`
            );
        });

        const requestUri = new URL(req.url);
        let contentType = req.headers["Content-Format"] as string;

        if (req.method === "PUT" || req.method === "POST") {
            if (!contentType && req.payload) {
                console.warn(
                    "[binding-coap]",
                    `CoapServer on port ${this.getPort()} received no Content-Format from ${Helpers.toUriLiteral(
                        req.rsinfo.address
                    )}:${req.rsinfo.port}`
                );
                contentType = ContentSerdes.DEFAULT;
            } else if (
                ContentSerdes.get().getSupportedMediaTypes().indexOf(ContentSerdes.getMediaType(contentType)) < 0
            ) {
                res.code = "4.15";
                res.end("Unsupported Media Type");
                return;
            }
        }

        // route request
        const segments = decodeURI(requestUri.pathname).split("/");

        if (segments[1] === "") {
            // no path -> list all Things
            if (req.method === "GET") {
                res.setHeader("Content-Format", ContentSerdes.DEFAULT);
                res.code = "2.05";
                const list = [];
                for (const address of Helpers.getAddresses()) {
                    // FIXME are Iterables really such a non-feature that I need array?
                    for (const name of Array.from(this.things.keys())) {
                        list.push(
                            this.scheme +
                                "://" +
                                Helpers.toUriLiteral(address) +
                                ":" +
                                this.getPort() +
                                "/" +
                                encodeURIComponent(name)
                        );
                    }
                }
                res.end(JSON.stringify(list));
            } else {
                res.code = "4.05";
                res.end("Method Not Allowed");
            }
            // resource found and response sent
            return;
        } else {
            // path -> select Thing
            const thing = this.things.get(segments[1]);
            if (thing) {
                if (segments.length === 2 || segments[2] === "") {
                    // Thing root -> send TD
                    if (req.method === "GET") {
                        res.setOption("Content-Format", ContentSerdes.TD);
                        res.code = "2.05";
                        res.end(JSON.stringify(thing.getThingDescription()));
                    } else {
                        res.code = "4.05";
                        res.end("Method Not Allowed");
                    }
                    // resource found and response sent
                    return;
                } else if (segments[2] === this.PROPERTY_DIR) {
                    // sub-path -> select Property
                    const property = thing.properties[segments[3]];
                    if (property) {
                        if (req.method === "GET") {
                            // readproperty
                            if (req.headers.Observe === undefined) {
                                thing
                                    .readProperty(segments[3])
                                    // property.read()
                                    .then((value) => {
                                        const contentType = ProtocolHelpers.getPropertyContentType(
                                            thing.getThingDescription(),
                                            segments[3],
                                            "coap"
                                        );
                                        const content = ContentSerdes.get().valueToContent(
                                            value,
                                            property,
                                            contentType
                                        );
                                        res.setOption("Content-Format", content.type);
                                        res.code = "2.05";
                                        res.end(content.body);
                                    })
                                    .catch((err) => {
                                        console.error(
                                            "[binding-coap]",
                                            `CoapServer on port ${this.getPort()} got internal error on read '${
                                                requestUri.pathname
                                            }': ${err.message}`
                                        );
                                        res.code = "5.00";
                                        res.end(err.message);
                                    });
                                // observeproperty
                            } else {
                                const oInterval = setInterval(() => {
                                    thing
                                        .readProperty(segments[3])
                                        // property.read() periodically
                                        .then((value) => {
                                            const contentType = ProtocolHelpers.getPropertyContentType(
                                                thing.getThingDescription(),
                                                segments[3],
                                                "coap"
                                            );
                                            const content = ContentSerdes.get().valueToContent(
                                                value,
                                                property,
                                                contentType
                                            );
                                            res.setOption("Content-Format", content.type);
                                            res.code = "2.05";
                                            res.write(content.body);

                                            res.on("finish", (err: Error) => {
                                                if (err) {
                                                    console.error(
                                                        "[binding-coap]",
                                                        `CoapServer on port ${this.port} failed on observe with: ${err.message}`
                                                    );
                                                }
                                                clearInterval(oInterval);
                                                res.end();
                                            });
                                        })
                                        .catch((err) => {
                                            console.error(
                                                "[binding-coap]",
                                                `CoapServer on port ${this.getPort()} got internal error on read '${
                                                    requestUri.pathname
                                                }': ${err.message}`
                                            );
                                            res.code = "5.00";
                                            res.end(err.message);
                                        });
                                }, 100);
                            }
                            // writeproperty
                        } else if (req.method === "PUT") {
                            if (!property.readOnly) {
                                let value;
                                try {
                                    value = ContentSerdes.get().contentToValue(
                                        { type: contentType, body: req.payload },
                                        property
                                    );
                                } catch (err) {
                                    console.warn(
                                        "[binding-coap]",
                                        `CoapServer on port ${this.getPort()} cannot process write data for Property '${
                                            segments[3]
                                        }: ${err.message}'`
                                    );
                                    res.code = "4.00";
                                    res.end("Invalid Data");
                                    return;
                                }
                                thing
                                    .writeProperty(segments[3], value)
                                    // property.write(value)
                                    .then(() => {
                                        res.code = "2.04";
                                        res.end("Changed");
                                    })
                                    .catch((err) => {
                                        console.error(
                                            "[binding-coap]",
                                            `CoapServer on port ${this.getPort()} got internal error on write '${
                                                requestUri.pathname
                                            }': ${err.message}`
                                        );
                                        res.code = "5.00";
                                        res.end(err.message);
                                    });
                            } else {
                                res.code = "4.00";
                                res.end("Property readOnly");
                            }
                        } else {
                            res.code = "4.05";
                            res.end("Method Not Allowed");
                        }
                        // resource found and response sent
                        return;
                    } // Property exists?
                } else if (segments[2] === this.ACTION_DIR) {
                    // sub-path -> select Action
                    const action = thing.actions[segments[3]];
                    if (action) {
                        // invokeaction
                        if (req.method === "POST") {
                            let input;
                            try {
                                input = ContentSerdes.get().contentToValue(
                                    { type: contentType, body: req.payload },
                                    action.input
                                );
                            } catch (err) {
                                console.warn(
                                    "[binding-coap]",
                                    `CoapServer on port ${this.getPort()} cannot process input to Action '${
                                        segments[3]
                                    }: ${err.message}'`
                                );
                                res.code = "4.00";
                                res.end("Invalid Input Data");
                                return;
                            }
                            thing
                                .invokeAction(segments[3], input)
                                // action.invoke(input)
                                .then((output) => {
                                    if (output) {
                                        const contentType = ProtocolHelpers.getActionContentType(
                                            thing.getThingDescription(),
                                            segments[3],
                                            "coap"
                                        );
                                        const content = ContentSerdes.get().valueToContent(
                                            output,
                                            action.output,
                                            contentType
                                        );
                                        res.setOption("Content-Format", content.type);
                                        res.code = "2.05";
                                        res.end(content.body);
                                    } else {
                                        res.code = "2.04";
                                        res.end();
                                    }
                                })
                                .catch((err) => {
                                    console.error(
                                        "[binding-coap]",
                                        `CoapServer on port ${this.getPort()} got internal error on invoke '${
                                            requestUri.pathname
                                        }': ${err.message}`
                                    );
                                    res.code = "5.00";
                                    res.end(err.message);
                                });
                        } else {
                            res.code = "4.05";
                            res.end("Method Not Allowed");
                        }
                        // resource found and response sent
                        return;
                    } // Action exists?
                } else if (segments[2] === this.EVENT_DIR) {
                    // sub-path -> select Event
                    const event = thing.events[segments[3]];
                    if (event) {
                        // subscribeevent
                        if (req.method === "GET") {
                            if (req.headers.Observe === 0) {
                                // work-around to avoid duplicate requests (resend due to no response)
                                // (node-coap does not deduplicate when Observe is set)
                                const packet = res._packet;
                                packet.code = "0.00";
                                packet.payload = Buffer.from("");
                                packet.reset = false;
                                packet.ack = true;
                                packet.token = Buffer.alloc(0);

                                res._send(res, packet);

                                res._packet.confirmable = res._request.confirmable;
                                res._packet.token = res._request.token;
                                // end of work-around

                                thing
                                    .subscribeEvent(
                                        segments[3],
                                        // let subscription = event.subscribe(
                                        (data) => {
                                            let content;
                                            try {
                                                const contentType = ProtocolHelpers.getEventContentType(
                                                    thing.getThingDescription(),
                                                    segments[3],
                                                    "coap"
                                                );
                                                content = ContentSerdes.get().valueToContent(
                                                    data,
                                                    event.data,
                                                    contentType
                                                );
                                            } catch (err) {
                                                console.warn(
                                                    "[binding-coap]",
                                                    `CoapServer on port ${this.getPort()} cannot process data for Event '${
                                                        segments[3]
                                                    }: ${err.message}'`
                                                );
                                                res.code = "5.00";
                                                res.end("Invalid Event Data");
                                                return;
                                            }

                                            // send event data
                                            console.debug(
                                                "[binding-coap]",
                                                `CoapServer on port ${this.getPort()} sends '${
                                                    segments[3]
                                                }' notification to ${Helpers.toUriLiteral(req.rsinfo.address)}:${
                                                    req.rsinfo.port
                                                }`
                                            );
                                            res.setOption("Content-Format", content.type);
                                            res.code = "2.05";
                                            res.write(content.body);
                                        }
                                        // ,
                                        // () => {
                                        //   console.log(`CoapServer on port ${this.getPort()} failed '${segments[3]}' subscription`);
                                        //   res.code = "5.00";
                                        //   res.end();
                                        // },
                                        // () => {
                                        //   console.log(`CoapServer on port ${this.getPort()} completes '${segments[3]}' subscription`);
                                        //   res.end();
                                        // }
                                    )
                                    .then(() => {
                                        console.debug(
                                            "[binding-coap]",
                                            `CoapServer on port ${this.getPort()} completes '${
                                                segments[3]
                                            }' subscription`
                                        );
                                        res.end();
                                    })
                                    .catch(() => {
                                        console.debug(
                                            "[binding-coap]",
                                            `CoapServer on port ${this.getPort()} failed '${segments[3]}' subscription`
                                        );
                                        res.code = "5.00";
                                        res.end();
                                    });
                                res.on("finish", () => {
                                    console.debug(
                                        "[binding-coap]",
                                        `CoapServer on port ${this.getPort()} ends '${
                                            segments[3]
                                        }' observation from ${Helpers.toUriLiteral(req.rsinfo.address)}:${
                                            req.rsinfo.port
                                        }`
                                    );
                                    thing.unsubscribeEvent(segments[3]);
                                    // subscription.unsubscribe();
                                });
                            } else if (req.headers.Observe > 0) {
                                console.debug(
                                    "[binding-coap]",
                                    `CoapServer on port ${this.getPort()} sends '${
                                        segments[3]
                                    }' response to ${Helpers.toUriLiteral(req.rsinfo.address)}:${req.rsinfo.port}`
                                );
                                // node-coap does not support GET cancellation
                                res.code = "5.01";
                                res.end("node-coap issue: no GET cancellation, send RST");
                            } else {
                                console.debug(
                                    "[binding-coap]",
                                    `CoapServer on port ${this.getPort()} rejects '${
                                        segments[3]
                                    }' read from ${Helpers.toUriLiteral(req.rsinfo.address)}:${req.rsinfo.port}`
                                );
                                res.code = "4.00";
                                res.end("No Observe Option");
                            }
                        } else {
                            res.code = "4.05";
                            res.end("Method Not Allowed");
                        }
                        // resource found and response sent
                        return;
                    } // Event exists?
                }
            } // Thing exists?
        }

        // resource not found
        res.code = "4.04";
        res.end("Not Found");
    }
}
