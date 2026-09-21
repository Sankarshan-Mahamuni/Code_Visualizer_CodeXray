import sys
import json
import os
import io
import contextlib
import traceback
import ast
import inspect
import copy


# ============================================================
# GLOBAL STATE
# ============================================================

SOURCE_FILE = ""

events = []
call_stack = []

step = 0
frame_counter = 0

conditions = {}

# Python real object id -> our visualization object id
object_ids = {}

# Our visualization object id -> object information
object_registry = {}

object_counter = 0


# ============================================================
# OBJECT ID
# ============================================================

def get_object_id(obj):
    global object_counter

    real_id = id(obj)

    if real_id not in object_ids:
        object_counter += 1
        object_ids[real_id] = f"obj_{object_counter}"

    return object_ids[real_id]


# ============================================================
# CHECK USER OBJECT
# ============================================================

def is_user_object(value):
    """
    Returns True only for actual user-created objects.

    We do NOT treat:
    - int
    - float
    - str
    - list
    - tuple
    - dict
    - functions
    - classes
    - modules

    as visualization objects.
    """

    if value is None:
        return False

    if isinstance(value, (bool, int, float, str, list, tuple, dict)):
        return False

    if isinstance(value, type):
        return False

    if inspect.isfunction(value):
        return False

    if inspect.ismethod(value):
        return False

    if inspect.isbuiltin(value):
        return False

    if inspect.ismodule(value):
        return False

    return hasattr(value, "__dict__")


# ============================================================
# OBJECT REGISTRY
# ============================================================

def register_object(obj):
    """
    Register objects and containers so they can be visualized.
    """

    object_id = get_object_id(obj)

    if object_id in object_registry:
        return object_id

    # Create placeholder first.
    # This prevents problems with self-referencing objects.
    object_registry[object_id] = {
        "type": type(obj).__name__,
        "fields": {}
    }

    fields = {}

    # -------------------------
    # Dictionary
    # -------------------------
    if isinstance(obj, dict):

        for key, value in obj.items():

            field_name = str(key)

            fields[field_name] = get_value(value)


    # -------------------------
    # List / Tuple
    # -------------------------
    elif isinstance(obj, (list, tuple)):

        for index, value in enumerate(obj):

            fields[str(index)] = get_value(value)


    # -------------------------
    # User-defined object
    # -------------------------
    elif hasattr(obj, "__dict__"):

        for name, value in obj.__dict__.items():

            if value is None:

                fields[name] = None

            elif (
                isinstance(value, (dict, list, tuple))
                or hasattr(value, "__dict__")
            ):

                fields[name] = get_value(value)

            else:

                fields[name] = get_value(value)


    object_registry[object_id] = {
        "type": type(obj).__name__,
        "fields": fields
    }

    return object_id


def refresh_object(obj):

    object_id = get_object_id(obj)

    fields = {}

    # -------------------------
    # Dictionary
    # -------------------------
    if isinstance(obj, dict):

        for key, value in obj.items():

            fields[str(key)] = get_value(value)


    # -------------------------
    # List / Tuple
    # -------------------------
    elif isinstance(obj, (list, tuple)):

        for index, value in enumerate(obj):

            fields[str(index)] = get_value(value)


    # -------------------------
    # User-defined object
    # -------------------------
    elif hasattr(obj, "__dict__"):

        for name, value in obj.__dict__.items():

            fields[name] = get_value(value)


    object_registry[object_id] = {
        "type": type(obj).__name__,
        "fields": fields
    }



def refresh_objects_from_frame(frame):
    """
    Find user-defined objects in the current frame
    and update the object registry.
    """

    for name, value in frame.f_locals.items():

        if name.startswith("__"):
            continue

        if is_user_object(value):
            refresh_object(value)


# ============================================================
# CONDITIONS
# ============================================================

def load_conditions(source_code):
    global conditions

    tree = ast.parse(source_code)

    conditions = {}

    for node in ast.walk(tree):

        if isinstance(node, ast.If):

            conditions[node.lineno] = ast.unparse(node.test)


# ============================================================
# VALUE CONVERSION
# ============================================================

def get_value(value):
    """
    Convert Python runtime values into JSON-friendly
    structures used by the visualization engine.
    """

    # None
    if value is None:
        return {
            "type": "None",
            "value": None
        }

    # Boolean
    if isinstance(value, bool):
        return {
            "type": "bool",
            "value": value
        }

    # Integer
    if isinstance(value, int):
        return {
            "type": "int",
            "value": value
        }

    # Float
    if isinstance(value, float):
        return {
            "type": "float",
            "value": value
        }

    # String
    if isinstance(value, str):
        return {
            "type": "str",
            "value": value
        }

    # User-defined object
    if is_user_object(value):

        object_id = register_object(value)

        return {
            "type": type(value).__name__,
            "objectId": object_id
        }
     # Track containers as memory objects
    if isinstance(value, (list, tuple, dict)):

        object_id = register_object(value)

        return {
            "type": type(value).__name__,
            "objectId": object_id
        }

    # Function
    if inspect.isfunction(value):

        return {
            "type": "function",
            "name": value.__name__
        }

    # Class
    if isinstance(value, type):

        return {
            "type": "class",
            "name": value.__name__
        }

    # Fallback
    try:

        return {
            "type": type(value).__name__,
            "value": repr(value)
        }

    except Exception:

        return {
            "type": type(value).__name__,
            "value": "<unavailable>"
        }


# ============================================================
# VARIABLES
# ============================================================

def get_variables(frame):

    variables = {}

    for name, value in frame.f_locals.items():

        if name.startswith("__"):
            continue

        try:

            variables[name] = get_value(value)

        except Exception:

            variables[name] = {
                "type": type(value).__name__,
                "value": repr(value)
            }

    return variables


# ============================================================
# REFERENCES
# ============================================================

def get_references(frame):

    references = {}

    for name, value in frame.f_locals.items():

        if name.startswith("__"):
            continue

        if is_user_object(value):

            references[name] = get_object_id(value)

    return references


# ============================================================
# CALL STACK
# ============================================================

def get_stack():

    stack = []

    for frame in call_stack:

        stack.append({
            "frameId": frame["frameId"],
            "parentFrameId": frame["parentFrameId"],
            "function": frame["function"]
        })

    return stack


# ============================================================
# EVENT CREATION
# ============================================================

def add_event(event_type, frame, line=None, extra=None):

    global step

    # VERY IMPORTANT:
    for name, value in frame.f_globals.items():

        if name.startswith("__"):
            continue

        try:

            if (
                isinstance(value, (dict, list, tuple))
                or hasattr(value, "__dict__")
            ):

                refresh_object(value)

        except Exception:
            pass

    # Update objects BEFORE taking the variable snapshot.
    refresh_objects_from_frame(frame)

    variables = get_variables(frame)

    references = get_references(frame)

    event = {
        "step": step,
        "line": line if line is not None else frame.f_lineno,
        "event": event_type,
        "function": frame.f_code.co_name,
        "frameId": call_stack[-1]["frameId"] if call_stack else None,

        "variables": variables,

        "references": references,

        "objects": copy.deepcopy(object_registry),

        "callStack": get_stack()
    }

    if extra:
        event.update(extra)

    events.append(event)

    step += 1


# ============================================================
# MEMORY READ
# ============================================================

def memory_read(container, key, line):

    frame = inspect.currentframe().f_back

    try:

        value = container[key]

        add_event(
            "MEMORY_READ",
            frame,
            line,
            {
                "containerType": type(container).__name__,
                "key": get_value(key),
                "value": get_value(value)
            }
        )

        # Dictionary lookup successful
        if isinstance(container, dict):

            add_event(
                "CACHE_HIT",
                frame,
                line,
                {
                    "containerType": "dict",
                    "key": get_value(key),
                    "value": get_value(value)
                }
            )

        return value

    except (KeyError, IndexError):

        if isinstance(container, dict):

            add_event(
                "CACHE_MISS",
                frame,
                line,
                {
                    "containerType": "dict",
                    "key": get_value(key)
                }
            )

        raise


# ============================================================
# MEMORY WRITE
# ============================================================

def memory_write(container, key, value, line):

    frame = inspect.currentframe().f_back

    container[key] = value

    add_event(
        "MEMORY_WRITE",
        frame,
        line,
        {
            "containerType": type(container).__name__,
            "key": get_value(key),
            "value": get_value(value)
        }
    )

    return value


# ============================================================
# AST MEMORY TRANSFORMER
# ============================================================

class MemoryTransformer(ast.NodeTransformer):

    def visit_Subscript(self, node):

        node = self.generic_visit(node)

        if isinstance(node.ctx, ast.Load):

            container = node.value

            key = node.slice

            new_node = ast.Call(
                func=ast.Name(
                    id="__memory_read",
                    ctx=ast.Load()
                ),

                args=[
                    container,
                    key,
                    ast.Constant(node.lineno)
                ],

                keywords=[]
            )

            return ast.copy_location(
                new_node,
                node
            )

        return node


    def visit_Assign(self, node):

        if len(node.targets) == 1:

            target = node.targets[0]

            if isinstance(target, ast.Subscript):

                container = target.value

                key = target.slice

                new_node = ast.Expr(
                    value=ast.Call(
                        func=ast.Name(
                            id="__memory_write",
                            ctx=ast.Load()
                        ),

                        args=[
                            container,
                            key,
                            node.value,
                            ast.Constant(node.lineno)
                        ],

                        keywords=[]
                    )
                )

                return ast.copy_location(
                    new_node,
                    node
                )

        return self.generic_visit(node)


# ============================================================
# TRACE FUNCTION
# ============================================================

def trace_function(frame, event, arg):

    if frame.f_code.co_filename != SOURCE_FILE:
        return None

    global frame_counter

    # --------------------------------------------------------
    # FUNCTION CALL
    # --------------------------------------------------------

    if event == "call":

        parent_id = None

        if call_stack:

            parent_id = call_stack[-1]["frameId"]

        frame_counter += 1

        frame_info = {
            "frameId": f"f{frame_counter}",

            "parentFrameId": parent_id,

            "function": frame.f_code.co_name
        }

        call_stack.append(frame_info)

        add_event(
            "FUNCTION_ENTER",

            frame,

            frame.f_lineno,

            {
                "arguments": {
                    name: get_value(value)

                    for name, value
                    in frame.f_locals.items()

                    if not name.startswith("__")
                }
            }
        )

        return trace_function


    # --------------------------------------------------------
    # NO ACTIVE CALL STACK
    # --------------------------------------------------------

    if not call_stack:

        return trace_function


    # --------------------------------------------------------
    # LINE EXECUTION
    # --------------------------------------------------------

    if event == "line":

        add_event(
            "LINE_EXECUTED",

            frame,

            frame.f_lineno
        )

        # Condition detection
        if frame.f_lineno in conditions:

            condition_text = conditions[
                frame.f_lineno
            ]

            try:

                result = eval(
                    condition_text,

                    frame.f_globals,

                    frame.f_locals
                )

                add_event(
                    "CONDITION_EVALUATED",

                    frame,

                    frame.f_lineno,

                    {
                        "condition": condition_text,

                        "result": bool(result)
                    }
                )

            except Exception:

                pass


    # --------------------------------------------------------
    # FUNCTION RETURN
    # --------------------------------------------------------

    elif event == "return":

        add_event(
            "FUNCTION_EXIT",

            frame,

            frame.f_lineno,

            {
                "returnValue": get_value(arg)
            }
        )

        if call_stack:

            call_stack.pop()


    # --------------------------------------------------------
    # EXCEPTION
    # --------------------------------------------------------

    elif event == "exception":

        exc_type, exc_value, _ = arg

        add_event(
            "ERROR",

            frame,

            frame.f_lineno,

            {
                "errorType": exc_type.__name__,

                "errorMessage": str(exc_value)
            }
        )


    return trace_function


# ============================================================
# RUN CODE
# ============================================================

def run_code(source_file):

    global SOURCE_FILE
    global events
    global call_stack
    global step
    global frame_counter
    global conditions
    global object_ids
    global object_registry
    global object_counter

    # --------------------------------------------------------
    # RESET EVERYTHING
    # --------------------------------------------------------

    SOURCE_FILE = os.path.abspath(source_file)

    events = []

    call_stack = []

    step = 0

    frame_counter = 0

    conditions = {}

    object_ids = {}

    object_registry = {}

    object_counter = 0


    output_buffer = io.StringIO()


    result = {

        "success": False,

        "events": [],

        "objects": {},

        "references": {},

        "output": "",

        "error": None
    }


    try:

        # ----------------------------------------------------
        # READ SOURCE
        # ----------------------------------------------------

        with open(
            source_file,
            "r"
        ) as file:

            code = file.read()


        # ----------------------------------------------------
        # LOAD CONDITIONS
        # ----------------------------------------------------

        load_conditions(code)


        # ----------------------------------------------------
        # PARSE AST
        # ----------------------------------------------------

        tree = ast.parse(code)


        # ----------------------------------------------------
        # INSTRUMENT MEMORY ACCESS
        # ----------------------------------------------------

        tree = MemoryTransformer().visit(tree)

        ast.fix_missing_locations(tree)


        # ----------------------------------------------------
        # COMPILE
        # ----------------------------------------------------

        compiled_code = compile(

            tree,

            SOURCE_FILE,

            "exec"
        )


        # ----------------------------------------------------
        # START TRACE
        # ----------------------------------------------------

        sys.settrace(trace_function)


        # ----------------------------------------------------
        # EXECUTE USER CODE
        # ----------------------------------------------------

        with contextlib.redirect_stdout(
            output_buffer
        ):

            exec(

                compiled_code,

                {
                    "__name__": "__main__",

                    "__memory_read": memory_read,

                    "__memory_write": memory_write
                }
            )


        # ----------------------------------------------------
        # STOP TRACE
        # ----------------------------------------------------

        sys.settrace(None)


        result["success"] = True


    except Exception as e:

        sys.settrace(None)

        result["error"] = {

            "type": type(e).__name__,

            "message": str(e),

            "traceback": traceback.format_exc()
        }


    # --------------------------------------------------------
    # FINAL DATA
    # --------------------------------------------------------

    result["events"] = events

    result["objects"] = object_registry

    result["output"] = output_buffer.getvalue()


    # --------------------------------------------------------
    # FINAL REFERENCES
    # --------------------------------------------------------

    if events:

        # Use the latest event's references
        result["references"] = events[-1].get(
            "references",
            {}
        )


    return result


# ============================================================
# MAIN
# ============================================================

def main():

    if len(sys.argv) < 2:

        print(
            json.dumps(
                {
                    "success": False,

                    "error": {
                        "type": "InputError",

                        "message":
                            "Source file not provided"
                    }
                }
            )
        )

        return


    result = run_code(
        sys.argv[1]
    )


    print(
        json.dumps(
            result,
            indent=2
        )
    )


# ============================================================
# ENTRY POINT
# ============================================================

if __name__ == "__main__":

    main()