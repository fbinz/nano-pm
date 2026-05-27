from data.models import Membership


class WorkspaceMiddleware:
    """Attach request.workspace and request.membership for authenticated users.

    Reads active_workspace_id from the session. If the user has exactly one
    workspace, auto-selects it. Sets request.workspace = None for anonymous
    users (login_required handles auth separately).
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.workspace = None
        request.membership = None

        if not getattr(request, "user", None) or not request.user.is_authenticated:
            return self.get_response(request)

        ws_id = request.session.get("active_workspace_id")
        if ws_id:
            try:
                m = Membership.objects.select_related("workspace").get(
                    user=request.user, workspace_id=ws_id
                )
                request.workspace = m.workspace
                request.membership = m
                return self.get_response(request)
            except Membership.DoesNotExist:
                del request.session["active_workspace_id"]

        memberships = list(
            Membership.objects.select_related("workspace")
            .filter(user=request.user)
            .order_by("workspace__name")
        )
        if memberships:
            m = memberships[0]
            request.session["active_workspace_id"] = m.workspace_id
            request.workspace = m.workspace
            request.membership = m

        return self.get_response(request)
