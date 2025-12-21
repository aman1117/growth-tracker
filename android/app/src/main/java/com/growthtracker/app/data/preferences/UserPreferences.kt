package com.growthtracker.app.data.preferences

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "auth_prefs")

class UserPreferences(private val context: Context) {
    private val dataStore = context.dataStore

    companion object {
        val ACCESS_TOKEN = stringPreferencesKey("access_token")
        val USERNAME = stringPreferencesKey("username")
        val USER_ID = intPreferencesKey("user_id")
    }

    val accessToken: Flow<String?> = dataStore.data.map { prefs ->
        prefs[ACCESS_TOKEN]
    }

    val username: Flow<String?> = dataStore.data.map { prefs ->
        prefs[USERNAME]
    }

    val userId: Flow<Int?> = dataStore.data.map { prefs ->
        prefs[USER_ID]
    }

    suspend fun saveAuthData(token: String, username: String, userId: Int) {
        dataStore.edit { prefs ->
            prefs[ACCESS_TOKEN] = token
            prefs[USERNAME] = username
            prefs[USER_ID] = userId
        }
    }

    suspend fun clearAuthData() {
        dataStore.edit { prefs ->
            prefs.clear()
        }
    }

    suspend fun getAccessToken(): String? {
        return dataStore.data.map { prefs ->
            prefs[ACCESS_TOKEN]
        }.first()
    }

    suspend fun getUsername(): String? {
        return dataStore.data.map { prefs ->
            prefs[USERNAME]
        }.first()
    }
}
