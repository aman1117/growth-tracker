package com.growthtracker.app.data.repository

import com.growthtracker.app.data.remote.api.GrowthTrackerApi
import com.growthtracker.app.data.remote.dto.SearchUsersRequest
import com.growthtracker.app.domain.model.User
import com.growthtracker.app.domain.repository.UserRepository
import com.growthtracker.app.util.ErrorUtils
import com.growthtracker.app.util.Resource
import javax.inject.Inject

class UserRepositoryImpl @Inject constructor(
    private val api: GrowthTrackerApi
) : UserRepository {

    override suspend fun searchUsers(query: String): Resource<List<User>> {
        return try {
            val response = api.searchUsers(SearchUsersRequest(query))
            if (response.success) {
                val users = response.data.map { dto ->
                    User(
                        id = dto.id,
                        username = dto.username,
                        email = dto.email
                    )
                }
                Resource.Success(users)
            } else {
                Resource.Error(response.error ?: "Failed to search users")
            }
        } catch (e: Exception) {
            Resource.Error(ErrorUtils.parseError(e))
        }
    }
}
