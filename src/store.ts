/*
 * Copyright (c) 2015 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-4-Clause
 */

import { getPersistentStore } from 'pc-nrfconnect-shared';

interface StoreSchema {
    settings: Settings;
    mruFiles: string[];
}

interface Settings {
    autoRead: boolean;
    autoReset: boolean;
}

const store = getPersistentStore<StoreSchema>();

export const getSettings = () => store.get('settings');
export const setSettings = (settings: Settings) =>
    store.set('settings', settings);

export const getMruFiles = () => store.get('mruFiles') ?? [];
export const setMruFiles = (files: string[]) => store.set('mruFiles', files);
