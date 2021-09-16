/********************************************************************************
 * Copyright (c) 2018 - 2019 Contributors to the Eclipse Foundation
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
 * CoAP client based on coap by mcollina
 */

let coap = require("coap");
import * as url from "url";
import * as net from "net";

import { Subscription } from "rxjs/Subscription";

// for Security definition
import * as TD from "@node-wot/td-tools";

import { ProtocolClient, Content, ContentSerdes, ProtocolHelpers } from "@node-wot/core";
import { CoapForm, CoapRequestConfig, CoapOption } from "./coap";
import CoapServer from "./coap-server";
import { Readable } from "stream";

export default class CoapClient implements ProtocolClient {

  // FIXME coap Agent closes socket when no messages in flight -> new socket with every request
  private agent: any;
  private readonly agentOptions: any;

  constructor(server?: CoapServer) {
    // if server is passed, feed its socket into the CoAP agent for socket re-use
    this.agent = new coap.Agent(server ? { socket: server.getSocket() } : undefined);
    this.agentOptions = server ? { socket: server.getSocket() } : {};
    
    // WoT-specific content formats
    coap.registerFormat(ContentSerdes.JSON_LD, 2100);
    // TODO also register content fromat with IANA
    // from experimental range for now
    coap.registerFormat(ContentSerdes.TD, 65100);
    // TODO need hook from ContentSerdes for runtime data formats
  }

  public toString(): string {
    return "[CoapClient]";
  }

  public readResource(form: CoapForm): Promise<Content> {
    return new Promise<Content>((resolve, reject) => {

      let req = this.generateRequest(form, "GET");

      console.debug("[binding-coap]",`CoapClient sending ${req.statusCode} to ${form.href}`);

      req.on("response", (res: any) => {
        console.debug("[binding-coap]",`CoapClient received ${res.code} from ${form.href}`);
        console.debug("[binding-coap]",`CoapClient received Content-Format: ${res.headers["Content-Format"]}`);
        
        // FIXME does not work with blockwise because of node-coap
        let contentType = res.headers["Content-Format"];
        if (!contentType) contentType = form.contentType;
        
        resolve({ type: contentType, body: Readable.from(res.payload) });
      });
      req.on("error", (err: Error) => reject(err));
      req.end();
    });
  }

  public writeResource(form: CoapForm, content: Content): Promise<any> {
    return new Promise<void>((resolve, reject) => {
      ProtocolHelpers.readStreamFully(content.body).then( (buffer) => {
        let req = this.generateRequest(form, "PUT");

        // TODO set Content-FOrmat

        console.debug("[binding-coap]", `CoapClient sending ${req.statusCode} to ${form.href}`);

        req.on("response", (res: any) => {
          console.debug("[binding-coap]", `CoapClient received ${res.code} from ${form.href}`);
          console.debug("[binding-coap]", `CoapClient received headers: ${JSON.stringify(res.headers)}`);
          resolve();
        });
        req.on("error", (err: Error) => reject(err));
        req.setOption("Content-Format", content.type);
        req.write(buffer);
        req.end();
      }).catch(reject)
    });
  }

  public invokeResource(form: CoapForm, content?: Content): Promise<Content> {
    return new Promise<Content>((resolve, reject) => {
      ProtocolHelpers.readStreamFully(content.body).then((buffer) => {
        let req = this.generateRequest(form, "POST");

        console.debug("[binding-coap]", `CoapClient sending ${req.statusCode} to ${form.href}`);

        req.on("response", (res: any) => {
          console.debug("[binding-coap]", `CoapClient received ${res.code} from ${form.href}`);
          console.debug("[binding-coap]", `CoapClient received Content-Format: ${res.headers["Content-Format"]}`);
          console.debug("[binding-coap]", `CoapClient received headers: ${JSON.stringify(res.headers)}`);
          let contentType = res.headers["Content-Format"];
          resolve({ type: contentType, body: Readable.from(res.payload) });
        });
        req.on("error", (err: Error) => reject(err));
        if (content) {
          req.setOption("Content-Format", content.type);
          req.write(buffer);
        }
        req.end();
      }).catch(reject)
      
    });
  }

  public unlinkResource(form: CoapForm): Promise<any> {
    return new Promise<void>((resolve, reject) => {

      let req = this.generateRequest(form, "GET", false);

      console.debug("[binding-coap]",`CoapClient sending ${req.statusCode} to ${form.href}`);

      req.on("response", (res: any) => {
        console.debug("[binding-coap]",`CoapClient received ${res.code} from ${form.href}`);
        console.debug("[binding-coap]",`CoapClient received headers: ${JSON.stringify(res.headers)}`);
        resolve();
      });
      req.on("error", (err: Error) => reject(err));
      req.end();
    });
  }

  public subscribeResource(form: CoapForm, next: ((value: any) => void), error?: (error: any) => void, complete?: () => void): Promise<Subscription> {
    return new Promise<Subscription>((resolve, reject) => {
      let req = this.generateRequest(form, "GET", true);

      console.debug("[binding-coap]",`CoapClient sending ${req.statusCode} to ${form.href}`);

      req.on("response", (res: any) => {
        console.debug("[binding-coap]",`CoapClient received ${res.code} from ${form.href}`);
        console.debug("[binding-coap]",`CoapClient received Content-Format: ${res.headers["Content-Format"]}`);

        // FIXME does not work with blockwise because of node-coap
        let contentType = res.headers["Content-Format"];
        if (!contentType) contentType = form.contentType;

        res.on('data', (data: any) => {
          next({ type: contentType, body: Readable.from(res.payload) });
        });

        resolve(new Subscription( () => { 
            res.close();
            if(complete) complete();
         }));
      });

      req.on("error", (err: any) => {error(err); });

      req.end();

      
    });
  }

  public start(): boolean {
    return true;
  }

  public stop(): boolean {
    // FIXME coap does not provide proper API to close Agent
    return true;
  }
  public setSecurity = (metadata: Array<TD.SecurityScheme>) => true;

  private uriToOptions(uri: string): CoapRequestConfig {
    let requestUri = url.parse(uri);
    let agentOptions = this.agentOptions;
    agentOptions.type = net.isIPv6(requestUri.hostname) ? "udp6" : "udp4";
    this.agent = new coap.Agent(agentOptions);

    let options: CoapRequestConfig = {
      agent: this.agent,
      hostname: requestUri.hostname,
      port: requestUri.port? parseInt(requestUri.port, 10) : 5683,
      pathname: requestUri.pathname,
      query: requestUri.query,
      observe: false,
      multicast: false,
      confirmable: true
    };

    // TODO auth

    return options;
  }

  private generateRequest(form: CoapForm, dflt: string, observable: boolean = false): any {

    let options: CoapRequestConfig = this.uriToOptions(form.href);

    options.method = dflt;

    if (typeof form["coap:methodCode"] === "number") {
      console.debug("[binding-coap]","CoapClient got Form 'methodCode'", form["coap:methodCode"]);
      switch (form["coap:methodCode"]) {
        case 1: options.method = "GET"; break;
        case 2: options.method = "POST"; break;
        case 3: options.method = "PUT"; break;
        case 4: options.method = "DELETE"; break;
        default: console.warn("[binding-coap]","CoapClient got invalid 'methodCode', using default", options.method);
      }
    }
    options.observe = observable;

    let req = this.agent.request(options);

    // apply form data
    if (typeof form.contentType === "string") {
      console.debug("[binding-coap]","CoapClient got Form 'contentType'", form.contentType);
      req.setOption("Accept", form.contentType);
    }
    if (Array.isArray(form["coap:options"])) {
      console.debug("[binding-coap]","CoapClient got Form 'options'", form["coap:options"]);
      let options = form["coap:options"] as Array<CoapOption>;
      for (let option of options) {
        req.setOption(option["coap:optionCode"], option["coap:optionValue"]);
      }
    } else if (typeof form["coap:options"] === "object") {
      console.warn("[binding-coap]","CoapClient got Form SINGLE-ENTRY 'options'", form["coap:options"]);
      let option = form["coap:options"] as CoapOption;
      req.setHeader(option["coap:optionCode"], option["coap:optionValue"]);
    }

    return req;
  }
}
