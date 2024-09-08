/**
 * Copyright (c) 2021, 2024 Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v1.0 as shown at https://oss.oracle.com/licenses/upl.
 */

import * as io from '@actions/io';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as core from '@actions/core';
import crypto from 'crypto';
import axios from 'axios';
import * as github from '@actions/github';

// Generate RSA key pair
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
});

async function calc_fingerprint(publicKey: crypto.KeyObject) : Promise<string> {
  const publicKeyData = publicKey.export({ type: 'spki', format: 'der' });
  const hash = crypto.createHash('sha256');
  hash.update(publicKeyData);
  return hash.digest('base64');
}

async function validate_oci_cli_installed_and_configured() {
  try {
      await exec.exec('oci', ['--version']);
  } catch (error) {
      
      throw new Error('OCI CLI is not installed or not configured');
  }
}

async function configure_oci_cli(privateKey: crypto.KeyObject, publicKey: crypto.KeyObject, upstToken: string, ociUser: string, ociFingerprint: string, ociTenancy: string, ociRegion: string) {
  // Setup and Initialization OCI CLI Profile
  const workspace = process.env.GITHUB_WORKSPACE || '';
  const ociConfigDir = path.join(workspace, '.oci');
  const ociConfigFile = path.join(ociConfigDir, 'config');
  const ociPrivateKeyFile = path.join(workspace, 'private_key.pem');
  const ociPublicKeyFile = path.join(workspace, 'public_key.pem');
  const upstTokenFile = path.join(workspace, 'session');
  const ociConfig = `[DEFAULT]
  user=${ociUser}
  fingerprint=${ociFingerprint}
  key_file=${ociPrivateKeyFile}
  tenancy=${ociTenancy}
  region=${ociRegion}
  security_token=${upstToken}
  `;

  // Create the .oci directory
  await io.mkdirP(ociConfigDir);

  // Write the OCI config file
  fs.writeFileSync(ociConfigFile, ociConfig);

  // Write the private key file
  fs.writeFileSync(ociPrivateKeyFile, privateKey.export({ type: 'pkcs1', format: 'pem' }) as string);

  // Write the public key file
  fs.writeFileSync(ociPublicKeyFile, publicKey.export({ type: 'spki', format: 'pem' }) as string);
  
  // Write the UPST token to the file system
  fs.writeFileSync(upstTokenFile, upstToken);
  
}

async function token_exchange_jwt_to_upst(token_exchange_url: string, client_cred: string, oci_public_key: string, subject_token: string): Promise<string> {
  const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${client_cred}`
  };
  const data = {
      'grant_type': 'urn:ietf:params:oauth:grant-type:token-exchange',
      'requested_token_type': 'urn:oci:token-type:oci-upst',
      'public_key': oci_public_key,
      'subject_token': subject_token,
      'subject_token_type': 'jwt'
  };
  const response = await axios.post(token_exchange_url, data, { headers: headers });
  return response.data;
}

async function run(): Promise<void> {
  try {
    // Setup and Initialization
    const workspace = process.env.GITHUB_WORKSPACE || '';
    const tempDir = path.join(os.tmpdir(), 'my-action-temp');

    // Input Handling
    const clientId = core.getInput('client_id', { required: true });
    const clientSecret = core.getInput('client_secret', { required: true });
    const domainBaseURL = core.getInput('domain_base_url', { required: true });
    const ociUser = core.getInput('oci_user', { required: true });
    const ociTenancy = core.getInput('oci_tenancy', { required: true });
    const ociRegion = core.getInput('oci_region', { required: true });
    const testToken = core.getInput('test_token', { required: true });

    // Get github OIDC JWT token
    const idToken = await core.getIDToken();
    if (!idToken) {
      throw new Error('Unable to obtain OIDC token');
    }
    console.info(`ID Token: ${idToken}`);

    // Setup OCI Domain confidential application OAuth Client Credentials
    let clientCreds = `${clientId}:${clientSecret}`;
    let authStringEncoded = Buffer.from(clientCreds).toString('base64');
    const ociFingerprint = await calc_fingerprint(publicKey);

    // Get the B64 encoded public key DER
    let publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    console.info(`Public Key B64: ${publicKeyB64}`);

    //Exchange JWT to UPST
    let upstToken = await token_exchange_jwt_to_upst(`${domainBaseURL}/oauth2/v1/token`, authStringEncoded, publicKeyB64, testToken?testToken : idToken);
    console.log(`UPST Token:  ${upstToken.access_token}`);
    await configure_oci_cli(privateKey, publicKey, upstToken.access_token, ociUser, ociFingerprint, ociTenancy, ociRegion);

    // Error Handling
  } catch (error) {
    core.setFailed(`Action failed with error: ${error}`);
  }
}

run();
