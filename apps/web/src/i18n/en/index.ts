// English UI strings: the source of truth. One file per area; plurals and parameters are functions.
import { common } from './common';
import { nav } from './nav';
import { errors } from './errors';
import { time } from './time';
import { layout } from './layout';
import { autoMode } from './autoMode';
import { palette } from './palette';
import { reauth } from './reauth';
import { secrets } from './secrets';
import { vaults } from './vaults';
import { projects } from './projects';
import { requests } from './requests';
import { approve } from './approve';
import { audit } from './audit';
import { auth } from './auth';
import { connect } from './connect';
import { devices } from './devices';
import { settings } from './settings';
import { standing } from './standing';

export const en = { common, nav, errors, time, layout, autoMode, palette, reauth, secrets, vaults, projects, requests, approve, audit, auth, connect, devices, settings, standing };

export type Messages = typeof en;
